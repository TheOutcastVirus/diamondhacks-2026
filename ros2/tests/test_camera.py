"""
test_camera.py

Standalone camera and detection test — no ROS2 required.

Opens the USB camera and runs the same MobileNet SSD detector used by
human_follower_node.py, displaying the live feed with bounding boxes,
confidence scores, and current follower state.

Usage:
    python3 tests/test_camera.py
    python3 tests/test_camera.py --device 1
    python3 tests/test_camera.py --threshold 0.35

Controls:
    q / Esc — quit
    s       — save current frame as snapshot.jpg
    p       — pause / resume
    +/-     — raise/lower confidence threshold by 0.05
"""

import argparse
import time
import cv2

# ---------------------------------------------------------------------------
# Model paths — same files used by cv_ctrl.py and human_follower_node
# ---------------------------------------------------------------------------
MODEL_PROTOTXT = '/home/dronelab/ugv_jetson/models/deploy.prototxt'
MODEL_WEIGHTS  = '/home/dronelab/ugv_jetson/models/mobilenet_iter_73000.caffemodel'
PERSON_CLASS   = 15   # VOC label index for "person"

# Bounding-box area thresholds — match params.yaml defaults
BOX_AREA_MIN = 8_000    # px² → TRACKING → APPROACHING
BOX_AREA_MAX = 25_000   # px² → HOLDING


def state_for_area(area: float) -> str:
    if area >= BOX_AREA_MAX:
        return 'HOLDING'
    if area >= BOX_AREA_MIN:
        return 'APPROACHING'
    return 'TRACKING'


def main():
    parser = argparse.ArgumentParser(description='Camera + MobileNet SSD detection test')
    parser.add_argument('--device',    type=int,   default=0,
                        help='Camera device index (default: 0 = /dev/video0)')
    parser.add_argument('--width',     type=int,   default=640)
    parser.add_argument('--height',    type=int,   default=480)
    parser.add_argument('--threshold', type=float, default=0.45,
                        help='Confidence threshold (default: 0.45)')
    args = parser.parse_args()

    threshold = args.threshold

    # ------------------------------------------------------------------
    # Load MobileNet SSD (Caffe)
    # ------------------------------------------------------------------
    print(f'[INFO] Loading MobileNet SSD...')
    net = cv2.dnn.readNetFromCaffe(MODEL_PROTOTXT, MODEL_WEIGHTS)
    print(f'[INFO] Model loaded.')

    # ------------------------------------------------------------------
    # Open camera with V4L2 backend (required on Jetson)
    # ------------------------------------------------------------------
    cap = cv2.VideoCapture(args.device, cv2.CAP_V4L2)
    if not cap.isOpened():
        fallback = 1 if args.device == 0 else 0
        print(f'[WARN] Device {args.device} failed, trying {fallback}')
        cap = cv2.VideoCapture(fallback, cv2.CAP_V4L2)
    if not cap.isOpened():
        print('[ERROR] No camera found.')
        return 1

    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    img_cx   = actual_w / 2.0
    print(f'[INFO] Camera ready — {actual_w}x{actual_h}')
    print(f'[INFO] Confidence threshold: {threshold:.2f}  (press +/- to adjust)')
    print(f'[INFO] Press q/Esc to quit, s to save frame, p to pause')

    # FPS smoothing
    fps_smooth = 0.0
    fps_alpha  = 0.1
    prev_time  = time.monotonic()
    paused     = False

    while True:
        if not paused:
            ret, frame = cap.read()
            if not ret:
                print('[ERROR] Frame read failed.')
                break

        img_h, img_w = frame.shape[:2]

        # ------------------------------------------------------------------
        # MobileNet SSD inference
        # ------------------------------------------------------------------
        blob = cv2.dnn.blobFromImage(
            frame, 0.007843, (300, 300), 127.5, swapRB=False)
        net.setInput(blob)
        detections = net.forward()   # (1, 1, 100, 7)

        # Collect all person detections above threshold
        people = []
        for i in range(detections.shape[2]):
            conf     = float(detections[0, 0, i, 2])
            class_id = int(detections[0, 0, i, 1])
            if class_id != PERSON_CLASS or conf < threshold:
                continue
            x1 = int(max(0, detections[0, 0, i, 3] * img_w))
            y1 = int(max(0, detections[0, 0, i, 4] * img_h))
            x2 = int(min(img_w, detections[0, 0, i, 5] * img_w))
            y2 = int(min(img_h, detections[0, 0, i, 6] * img_h))
            people.append((conf, x1, y1, x2 - x1, y2 - y1))

        # Best detection = highest confidence
        best = max(people, key=lambda d: d[0]) if people else None

        # ------------------------------------------------------------------
        # Draw annotations
        # ------------------------------------------------------------------
        display = frame.copy()

        # Centre cross-hair
        cx, cy = int(img_cx), int(img_h / 2)
        cv2.line(display, (cx - 20, cy), (cx + 20, cy), (200, 200, 200), 1)
        cv2.line(display, (cx, cy - 20), (cx, cy + 20), (200, 200, 200), 1)

        # All detections in grey
        for (conf, x, y, w, h) in people:
            cv2.rectangle(display, (x, y), (x + w, y + h), (150, 150, 150), 1)

        node_state = 'SEARCHING'
        if best is not None:
            bconf, bx, by, bw, bh = best
            area       = bw * bh
            node_state = state_for_area(area)

            colour = {
                'TRACKING':    (0, 255, 255),
                'APPROACHING': (0, 165, 255),
                'HOLDING':     (0, 255,   0),
            }[node_state]

            cv2.rectangle(display, (bx, by), (bx + bw, by + bh), colour, 2)

            bcx, bcy = bx + bw // 2, by + bh // 2
            cv2.circle(display, (bcx, bcy), 5, colour, -1)
            cv2.line(display, (cx, cy), (bcx, bcy), (100, 100, 255), 1)

            label = f'person {bconf:.0%}  area={area:.0f}'
            cv2.putText(display, label, (bx, by - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, colour, 2)

        # ------------------------------------------------------------------
        # HUD
        # ------------------------------------------------------------------
        now   = time.monotonic()
        dt    = now - prev_time
        prev_time = now
        if dt > 0:
            fps_smooth = fps_alpha * (1.0 / dt) + (1 - fps_alpha) * fps_smooth

        hud = [
            f'State     : {node_state}',
            f'Detections: {len(people)}',
            f'Threshold : {threshold:.2f}  (+/- to adjust)',
            f'FPS       : {fps_smooth:.1f}',
        ]
        if paused:
            hud.insert(0, '*** PAUSED ***')

        for i, line in enumerate(hud):
            y_pos = 24 + i * 22
            cv2.putText(display, line, (10, y_pos),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
            cv2.putText(display, line, (10, y_pos),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1)

        cv2.putText(display,
                    f'<{BOX_AREA_MIN}px²=TRACKING  >{BOX_AREA_MAX}px²=HOLDING',
                    (10, actual_h - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.38, (180, 180, 180), 1)

        cv2.imshow('Human Follower — Camera Test', display)

        # ------------------------------------------------------------------
        # Keys
        # ------------------------------------------------------------------
        key = cv2.waitKey(1) & 0xFF
        if key in (ord('q'), 27):
            break
        elif key == ord('s'):
            cv2.imwrite('snapshot.jpg', display)
            print('[INFO] Saved snapshot.jpg')
        elif key == ord('p'):
            paused = not paused
            print(f'[INFO] {"Paused" if paused else "Resumed"}')
        elif key == ord('+') or key == ord('='):
            threshold = min(0.95, threshold + 0.05)
            print(f'[INFO] Threshold → {threshold:.2f}')
        elif key == ord('-'):
            threshold = max(0.05, threshold - 0.05)
            print(f'[INFO] Threshold → {threshold:.2f}')

    cap.release()
    cv2.destroyAllWindows()
    print('[INFO] Done.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
