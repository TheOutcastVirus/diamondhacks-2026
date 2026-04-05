#!/usr/bin/env python3
"""Capture a single frame from the robot's camera and save it to the given path."""
import sys
import time

try:
    import cv2
except ImportError:
    print("ERROR: opencv-python is not installed. Run: pip install opencv-python", file=sys.stderr)
    sys.exit(1)


def capture_image(output_path: str, device: int = 0) -> bool:
    cap = cv2.VideoCapture(device)
    if not cap.isOpened():
        alt = 1 if device == 0 else 0
        cap = cv2.VideoCapture(alt)
        if not cap.isOpened():
            return False

    # Allow the camera to warm up before reading a frame
    time.sleep(0.3)

    ret, frame = cap.read()
    cap.release()

    if not ret or frame is None:
        return False

    cv2.imwrite(output_path, frame)
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: capture_image.py <output_path> [device_index]", file=sys.stderr)
        sys.exit(1)

    out_path = sys.argv[1]
    dev = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    if capture_image(out_path, dev):
        print(out_path)
        sys.exit(0)
    else:
        print("ERROR: Failed to capture image from camera", file=sys.stderr)
        sys.exit(1)
