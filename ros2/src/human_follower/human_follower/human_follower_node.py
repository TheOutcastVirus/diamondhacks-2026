"""
human_follower_node.py

Differential drive tracked robot that follows a human using a swivel/tilt camera
and a MobileNet SSD DNN detector (same model used by cv_ctrl.py).

Topics
------
Subscriptions:
  /camera/image_raw  (sensor_msgs/Image)          -- raw camera frame

Publications:
  /cmd_vel           (geometry_msgs/Twist)         -- drive commands (also sent to hardware)
  /camera/pan_tilt   (std_msgs/Float32MultiArray)  -- [pan_deg, tilt_deg] (also sent to hardware)

State machine
-------------
  SEARCHING   -- no person visible; robot slowly spins, camera sweeps
  TRACKING    -- person detected; align heading + camera to center the person
  APPROACHING -- person centered; drive forward
  HOLDING     -- person bounding-box is large enough (proxy for "close"); stop
"""

import math
import os
import rclpy
from rclpy.node import Node
from rclpy.parameter import Parameter

from sensor_msgs.msg import Image
from geometry_msgs.msg import Twist
from std_msgs.msg import Float32MultiArray

import cv2
from cv_bridge import CvBridge

# ---------------------------------------------------------------------------
# Hardware back-end — BaseController from the ugv_jetson control stack.
# sys.path is extended so base_ctrl.py can find its config.yaml via
# os.path.realpath(__file__), which resolves to /home/dronelab/ugv_jetson/.
# Falls back to ROS-only mode (topics only) if the import fails.
# ---------------------------------------------------------------------------
import sys as _sys
_sys.path.insert(0, '/home/dronelab/ugv_jetson')
try:
    from base_ctrl import BaseController as _BaseController
    _HW_AVAILABLE = True
except ImportError:
    _HW_AVAILABLE = False
    _BaseController = None


# ---------------------------------------------------------------------------
# State definitions
# ---------------------------------------------------------------------------
class State:
    SEARCHING   = 'SEARCHING'
    TRACKING    = 'TRACKING'
    APPROACHING = 'APPROACHING'
    HOLDING     = 'HOLDING'


class HumanFollowerNode(Node):

    def __init__(self):
        super().__init__('human_follower_node')

        # ------------------------------------------------------------------
        # Parameters (tunable via params.yaml or ros2 param set)
        # ------------------------------------------------------------------
        self.declare_parameter('linear_speed',            0.3)   # m/s forward
        self.declare_parameter('angular_speed',           0.5)   # rad/s max yaw
        self.declare_parameter('search_angular_speed',    0.3)   # rad/s spin while searching
        self.declare_parameter('target_box_area_min',  8000.0)   # px² → start approaching
        self.declare_parameter('target_box_area_max', 25000.0)   # px² → close enough, hold
        self.declare_parameter('lateral_gain',            1.8)   # proportional gain for centering
        self.declare_parameter('pan_gain',                0.06)  # deg/px proportional for pan
        self.declare_parameter('tilt_offset_deg',        -5.0)   # static tilt to look slightly down
        self.declare_parameter('pan_limit_deg',          60.0)   # max pan from center (±)
        self.declare_parameter('camera_search_sweep_deg', 45.0)  # sweep amplitude during search
        self.declare_parameter('camera_search_speed',     2.0)   # deg/step sweep speed
        # MobileNet SSD detector
        self.declare_parameter('model_prototxt',
            '/home/dronelab/ugv_jetson/models/deploy.prototxt')
        self.declare_parameter('model_weights',
            '/home/dronelab/ugv_jetson/models/mobilenet_iter_73000.caffemodel')
        self.declare_parameter('confidence_threshold',  0.45)
        self.declare_parameter('show_viewer',           False)

        # Hardware integration parameters
        self.declare_parameter('serial_port',      '/dev/ttyTHS1')
        self.declare_parameter('wheel_separation',  0.3)    # meters — tune to actual track width
        self.declare_parameter('gimbal_spd_rate',  60.0)    # matches config.yaml cv.track_spd_rate
        self.declare_parameter('gimbal_acc_rate',   0.4)    # matches config.yaml cv.track_acc_rate
        self.declare_parameter('gimbal_max_spd',  500.0)    # upper cap on SPD command value

        self._read_params()

        # ------------------------------------------------------------------
        # Hardware controller (BaseController over UART to ESP32)
        # ------------------------------------------------------------------
        self._base = None
        if _HW_AVAILABLE:
            try:
                self._base = _BaseController(self._serial_port, 115200)
                self.get_logger().info(
                    f'BaseController opened on {self._serial_port}')
                # Home the gimbal: face forward at the configured tilt angle.
                self._base.gimbal_ctrl(0.0, self._tilt_offset_deg, 100, 10)
            except Exception as e:
                self.get_logger().error(
                    f'Failed to open BaseController on {self._serial_port}: {e} '
                    f'— running in ROS-only mode')
        else:
            self.get_logger().warn(
                'base_ctrl module not importable — running in ROS-only mode')

        # ------------------------------------------------------------------
        # MobileNet SSD detector — same model/weights used by cv_ctrl.py.
        # VOC class 15 = "person".  Input: 300x300 blob, scale 1/127.5, mean 127.5.
        # ------------------------------------------------------------------
        self._net = cv2.dnn.readNetFromCaffe(
            self._model_prototxt, self._model_weights)
        self._bridge = CvBridge()
        self.get_logger().info('MobileNet SSD detector loaded')

        if self._show_viewer:
            try:
                cv2.namedWindow('Human Follower — Live View', cv2.WINDOW_NORMAL)
                self.get_logger().info(
                    'Viewer window open  (q=quit, s=save snapshot, +/-=threshold)')
            except Exception as e:
                self.get_logger().warn(f'No display available, viewer disabled: {e}')
                self._show_viewer = False

        # ------------------------------------------------------------------
        # State
        # ------------------------------------------------------------------
        self._state = State.SEARCHING
        self._current_pan_deg  = 0.0   # positive = pan right
        self._sweep_direction  = 1.0   # +1 or -1 for search sweep

        # ------------------------------------------------------------------
        # Publishers
        # ------------------------------------------------------------------
        self._cmd_vel_pub = self.create_publisher(Twist, '/cmd_vel', 10)
        self._pan_tilt_pub = self.create_publisher(
            Float32MultiArray, '/camera/pan_tilt', 10)

        # ------------------------------------------------------------------
        # Subscribers
        # ------------------------------------------------------------------
        self.create_subscription(
            Image, '/camera/image_raw', self._image_callback, 10)

        self.get_logger().info(
            f'HumanFollowerNode started — initial state: {self._state}')

    # ------------------------------------------------------------------
    # Parameter helpers
    # ------------------------------------------------------------------

    def _read_params(self):
        p = self.get_parameter
        self._linear_speed          = p('linear_speed').value
        self._angular_speed         = p('angular_speed').value
        self._search_angular_speed  = p('search_angular_speed').value
        self._box_area_min          = p('target_box_area_min').value
        self._box_area_max          = p('target_box_area_max').value
        self._lateral_gain          = p('lateral_gain').value
        self._pan_gain              = p('pan_gain').value
        self._tilt_offset_deg       = p('tilt_offset_deg').value
        self._pan_limit_deg         = p('pan_limit_deg').value
        self._sweep_amplitude       = p('camera_search_sweep_deg').value
        self._sweep_speed           = p('camera_search_speed').value
        self._model_prototxt        = p('model_prototxt').value
        self._model_weights         = p('model_weights').value
        self._confidence_threshold  = p('confidence_threshold').value
        self._show_viewer           = p('show_viewer').value
        self._serial_port           = p('serial_port').value
        self._wheel_separation      = p('wheel_separation').value
        self._gimbal_spd_rate       = p('gimbal_spd_rate').value
        self._gimbal_acc_rate       = p('gimbal_acc_rate').value
        self._gimbal_max_spd        = p('gimbal_max_spd').value

    # ------------------------------------------------------------------
    # Core callback
    # ------------------------------------------------------------------

    def _image_callback(self, msg: Image):
        try:
            frame = self._bridge.imgmsg_to_cv2(msg, desired_encoding='bgr8')
        except Exception as e:
            self.get_logger().error(f'cv_bridge conversion failed: {e}')
            return

        img_h, img_w = frame.shape[:2]
        img_cx = img_w / 2.0

        best_box = self._detect_person(frame, img_w, img_h)

        if best_box is None:
            self._handle_no_detection()
            if self._show_viewer:
                self._draw_viewer(frame, img_w, img_h, None, self._state)
        else:
            x, y, w, h = best_box
            box_cx   = x + w / 2.0
            box_area = float(w * h)
            self._handle_detection(box_cx, box_area, img_cx)
            if self._show_viewer:
                self._draw_viewer(frame, img_w, img_h, best_box, self._state)

    # ------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------

    def _detect_person(self, frame, img_w, img_h):
        """
        Run MobileNet SSD and return the highest-confidence person box as
        (x, y, w, h) in pixels, or None if no person passes the threshold.
        VOC class 15 = person.
        """
        blob = cv2.dnn.blobFromImage(
            frame, 0.007843, (300, 300), 127.5, swapRB=False)
        self._net.setInput(blob)
        detections = self._net.forward()   # shape: (1, 1, 100, 7)

        best_box   = None
        best_conf  = 0.0

        for i in range(detections.shape[2]):
            confidence = float(detections[0, 0, i, 2])
            class_id   = int(detections[0, 0, i, 1])

            if class_id != 15 or confidence < self._confidence_threshold:
                continue

            # Normalised coords → pixel coords
            x1 = int(detections[0, 0, i, 3] * img_w)
            y1 = int(detections[0, 0, i, 4] * img_h)
            x2 = int(detections[0, 0, i, 5] * img_w)
            y2 = int(detections[0, 0, i, 6] * img_h)

            # Clamp to frame bounds
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(img_w, x2), min(img_h, y2)

            if confidence > best_conf:
                best_conf = confidence
                best_box  = (x1, y1, x2 - x1, y2 - y1)   # (x, y, w, h)

        return best_box

    # ------------------------------------------------------------------
    # Viewer
    # ------------------------------------------------------------------

    def _draw_viewer(self, frame, img_w, img_h, best_box, state: str):
        _COLOURS = {
            'SEARCHING':   (200, 200, 200),
            'TRACKING':    (0, 255, 255),
            'APPROACHING': (0, 165, 255),
            'HOLDING':     (0, 255,   0),
        }
        display = frame.copy()
        cx, cy  = img_w // 2, img_h // 2

        # Centre cross-hair
        cv2.line(display, (cx - 20, cy), (cx + 20, cy), (200, 200, 200), 1)
        cv2.line(display, (cx, cy - 20), (cx, cy + 20), (200, 200, 200), 1)

        if best_box is not None:
            x, y, w, h = best_box
            area  = w * h
            col   = _COLOURS.get(state, (255, 255, 255))
            bcx, bcy = x + w // 2, y + h // 2

            cv2.rectangle(display, (x, y), (x + w, y + h), col, 2)
            cv2.circle(display, (bcx, bcy), 5, col, -1)
            cv2.line(display, (cx, cy), (bcx, bcy), (100, 100, 255), 1)
            cv2.putText(display, f'{state}  area={area:.0f}',
                        (x, y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2)

        # HUD
        hud = [
            f'State     : {state}',
            f'Threshold : {self._confidence_threshold:.2f}  (+/- to adjust)',
        ]
        for i, line in enumerate(hud):
            yp = 24 + i * 22
            cv2.putText(display, line, (10, yp),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
            cv2.putText(display, line, (10, yp),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1)

        try:
            cv2.imshow('Human Follower — Live View', display)
            key = cv2.waitKey(1) & 0xFF
        except Exception as e:
            self.get_logger().warn(f'Display lost, viewer disabled: {e}')
            self._show_viewer = False
            cv2.destroyAllWindows()
            return

        if key in (ord('q'), 27):
            cv2.destroyAllWindows()
            rclpy.shutdown()
        elif key == ord('s'):
            cv2.imwrite('snapshot.jpg', display)
            self.get_logger().info('Saved snapshot.jpg')
        elif key in (ord('+'), ord('=')):
            self._confidence_threshold = min(0.95, self._confidence_threshold + 0.05)
            self.get_logger().info(f'Threshold → {self._confidence_threshold:.2f}')
        elif key == ord('-'):
            self._confidence_threshold = max(0.05, self._confidence_threshold - 0.05)
            self.get_logger().info(f'Threshold → {self._confidence_threshold:.2f}')

    # ------------------------------------------------------------------
    # State handlers
    # ------------------------------------------------------------------

    def _handle_no_detection(self):
        """No person in frame — enter/stay in SEARCHING state."""
        if self._state != State.SEARCHING:
            self.get_logger().info('Person lost — SEARCHING')
        self._state = State.SEARCHING

        # Spin the chassis slowly to scan. Camera stays fixed facing forward.
        twist = Twist()
        twist.angular.z = self._search_angular_speed * self._sweep_direction
        self._cmd_vel_pub.publish(twist)
        self._hw_drive(0.0, twist.angular.z)

    def _handle_detection(self, box_cx: float, box_area: float, img_cx: float):
        """Person detected — decide state based on proximity and alignment."""
        lateral_error = box_cx - img_cx   # pixels; positive = person is to the right

        if box_area >= self._box_area_max:
            # Close enough — no forward drive, but keep rotating to stay centered.
            if self._state != State.HOLDING:
                self.get_logger().info(
                    f'Person is close (area={box_area:.0f}) — HOLDING')
            self._state = State.HOLDING
            twist = Twist()
            norm_error = lateral_error / max(img_cx, 1.0)
            angular_cmd = -norm_error * self._lateral_gain * self._angular_speed
            twist.angular.z = max(-self._angular_speed,
                                  min(self._angular_speed, angular_cmd))
            self._cmd_vel_pub.publish(twist)
            self._hw_drive(0.0, twist.angular.z)
        elif box_area >= self._box_area_min:
            # In range — approach while staying centered
            if self._state != State.APPROACHING:
                self.get_logger().info(
                    f'Person in range (area={box_area:.0f}) — APPROACHING')
            self._state = State.APPROACHING
            self._drive_toward(lateral_error, img_cx)
        else:
            # Detected but far — center on person first
            if self._state not in (State.TRACKING, State.APPROACHING):
                self.get_logger().info(
                    f'Person detected (area={box_area:.0f}) — TRACKING')
            self._state = State.TRACKING
            self._drive_toward(lateral_error, img_cx)

        # Camera stays fixed facing forward — chassis turning handles alignment.

    # ------------------------------------------------------------------
    # Drive helpers
    # ------------------------------------------------------------------

    def _twist_to_diff_drive(self, linear_x: float, angular_z: float):
        """
        Convert Twist (linear_x m/s, angular_z rad/s) to per-wheel speeds.
        Standard unicycle model: left = v - ω*(sep/2), right = v + ω*(sep/2).
        Clamped to ±1.3 m/s (config.yaml args_config.max_speed for UGV Rover).
        """
        half_sep = self._wheel_separation / 2.0
        left  = linear_x - angular_z * half_sep
        right = linear_x + angular_z * half_sep
        max_spd = 1.3
        return (max(-max_spd, min(max_spd, left)),
                max(-max_spd, min(max_spd, right)))

    def _hw_drive(self, linear_x: float, angular_z: float):
        """Send a drive command directly to the base hardware."""
        if self._base is None:
            return
        left, right = self._twist_to_diff_drive(linear_x, angular_z)
        self._base.base_speed_ctrl(left, right)

    def _hw_gimbal(self, pan_deg: float, tilt_deg: float, lateral_error_px: float):
        """
        Send a pan/tilt command directly to the gimbal hardware.
        SPD and ACC are computed proportionally from pixel error, matching
        cv_ctrl.py's gimbal_track() formula: SPD = abs(px)*spd_rate, ACC = abs(px)*acc_rate.
        """
        if self._base is None:
            return
        abs_err = abs(lateral_error_px)
        spd = int(min(abs_err * self._gimbal_spd_rate, self._gimbal_max_spd))
        acc = int(abs_err * self._gimbal_acc_rate)
        self._base.gimbal_ctrl(pan_deg, tilt_deg, max(1, spd), max(1, acc))

    def _drive_toward(self, lateral_error: float, img_cx: float):
        """
        Publish a Twist that drives forward and corrects yaw to center the person.
        lateral_error > 0 means person is to the right → turn right (negative angular.z).
        """
        twist = Twist()

        # Normalise error to [-1, 1] based on half-image width
        norm_error = lateral_error / max(img_cx, 1.0)

        # Angular correction — proportional
        angular_cmd = -norm_error * self._lateral_gain * self._angular_speed
        angular_cmd = max(-self._angular_speed,
                          min(self._angular_speed, angular_cmd))

        # Only drive forward if well aligned (|norm_error| < 0.2)
        if abs(norm_error) < 0.2:
            twist.linear.x = self._linear_speed
        else:
            # Rotate in place to re-align first
            twist.linear.x = 0.0

        twist.angular.z = angular_cmd
        self._cmd_vel_pub.publish(twist)
        self._hw_drive(twist.linear.x, twist.angular.z)

    def _stop_robot(self):
        self._cmd_vel_pub.publish(Twist())
        self._hw_drive(0.0, 0.0)

    # ------------------------------------------------------------------
    # Camera publisher
    # ------------------------------------------------------------------

    def _publish_pan_tilt(self, pan_deg: float, tilt_deg: float):
        msg = Float32MultiArray()
        msg.data = [float(pan_deg), float(tilt_deg)]
        self._pan_tilt_pub.publish(msg)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(args=None):
    rclpy.init(args=args)
    node = HumanFollowerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node._stop_robot()
        if node._base is not None:
            try:
                node._base.base_speed_ctrl(0, 0)
                node._base.gimbal_dev_close()
            except Exception as e:
                node.get_logger().error(f'Hardware cleanup error: {e}')
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
