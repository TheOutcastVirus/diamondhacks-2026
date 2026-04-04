"""
camera_publisher_node.py

Publishes USB camera frames to /camera/image_raw so that
human_follower_node.py (and ros2 topic echo, rviz, etc.) can consume them.

Uses the V4L2 backend explicitly (cv2.CAP_V4L2) — required on Jetson where
the default GStreamer backend cannot autodetect USB cameras by index.

Parameters (set via params.yaml or ros2 param set):
  camera_device   int    0         (0 = /dev/video0, 1 = /dev/video1)
  frame_width     int    640
  frame_height    int    480
  publish_rate    float  30.0      target publish rate in Hz
"""

import cv2
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from cv_bridge import CvBridge


class CameraPublisherNode(Node):

    def __init__(self):
        super().__init__('camera_publisher_node')

        self.declare_parameter('camera_device',  0)
        self.declare_parameter('frame_width',  640)
        self.declare_parameter('frame_height', 480)
        self.declare_parameter('publish_rate', 30.0)

        device   = self.get_parameter('camera_device').value
        width    = self.get_parameter('frame_width').value
        height   = self.get_parameter('frame_height').value
        rate_hz  = self.get_parameter('publish_rate').value

        self._bridge = CvBridge()
        self._pub    = self.create_publisher(Image, '/camera/image_raw', 10)
        self._cap    = self._open_camera(device, width, height)

        if self._cap is None:
            self.get_logger().fatal(
                'No camera available — shutting down camera_publisher_node')
            raise RuntimeError('Camera open failed')

        period = 1.0 / rate_hz
        self.create_timer(period, self._timer_cb)
        self.get_logger().info(
            f'CameraPublisherNode started — /dev/video{device} '
            f'{width}x{height} @ {rate_hz:.0f} Hz → /camera/image_raw')

    # ------------------------------------------------------------------

    def _open_camera(self, device: int, width: int, height: int):
        """
        Open the camera with the V4L2 backend (required on Jetson).
        Tries the requested device first, then the other one as fallback.
        Verifies that a frame can actually be read before returning.
        """
        for dev in self._device_order(device):
            self.get_logger().info(f'Trying /dev/video{dev} (V4L2)...')
            cap = cv2.VideoCapture(dev, cv2.CAP_V4L2)
            if not cap.isOpened():
                self.get_logger().warn(f'/dev/video{dev} did not open')
                continue

            cap.set(cv2.CAP_PROP_FRAME_WIDTH,  width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)

            # Verify we can actually read a frame
            ret, _ = cap.read()
            if not ret:
                self.get_logger().warn(
                    f'/dev/video{dev} opened but frame read failed — skipping')
                cap.release()
                continue

            actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            self.get_logger().info(
                f'/dev/video{dev} ready — actual resolution: {actual_w}x{actual_h}')
            return cap

        return None

    @staticmethod
    def _device_order(preferred: int):
        """Return [preferred, fallback] device indices."""
        candidates = [0, 1]
        ordered = [preferred] + [d for d in candidates if d != preferred]
        return ordered

    def _timer_cb(self):
        ret, frame = self._cap.read()
        if not ret:
            self.get_logger().warn('Frame read failed', throttle_duration_sec=5.0)
            return

        msg = self._bridge.cv2_to_imgmsg(frame, encoding='bgr8')
        msg.header.stamp    = self.get_clock().now().to_msg()
        msg.header.frame_id = 'camera'
        self._pub.publish(msg)

    def destroy_node(self):
        if self._cap is not None:
            self._cap.release()
        super().destroy_node()


# ---------------------------------------------------------------------------

def main(args=None):
    rclpy.init(args=args)
    node = CameraPublisherNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
