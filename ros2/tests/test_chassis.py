"""
test_chassis.py

Standalone chassis movement test — no ROS2 required.

Exercises the BaseController directly over serial to verify:
  - Serial connection to the ESP32
  - Forward / backward drive
  - Spin left / spin right in place
  - Differential (arc) turns
  - Emergency stop

IMPORTANT: The robot WILL move. Make sure it has clear space (>1 m)
around it before running this test.

Usage:
    python3 tests/test_chassis.py
    python3 tests/test_chassis.py --port /dev/ttyTHS0
    python3 tests/test_chassis.py --dry-run   # print commands only, no serial
"""

import argparse
import sys
import time

# Reach base_ctrl.py from the ugv_jetson root
sys.path.insert(0, '/home/dronelab/ugv_jetson')

# ---------------------------------------------------------------------------
# Test sequence definition
# Each entry: (description, left_speed, right_speed, duration_s)
# Speeds are in m/s.  Positive = forward.
# ---------------------------------------------------------------------------
TEST_STEPS = [
    ('Drive forward  (0.20 m/s)',   0.20,  0.20, 2.0),
    ('Stop',                         0.00,  0.00, 0.5),
    ('Drive backward (-0.20 m/s)', -0.20, -0.20, 2.0),
    ('Stop',                         0.00,  0.00, 0.5),
    ('Spin left  in place',         -0.20,  0.20, 1.5),
    ('Stop',                         0.00,  0.00, 0.5),
    ('Spin right in place',          0.20, -0.20, 1.5),
    ('Stop',                         0.00,  0.00, 0.5),
    ('Arc turn left  (forward)',     0.10,  0.25, 2.0),
    ('Stop',                         0.00,  0.00, 0.5),
    ('Arc turn right (forward)',     0.25,  0.10, 2.0),
    ('Stop',                         0.00,  0.00, 0.5),
]


def _bar(current: int, total: int, width: int = 20) -> str:
    filled = int(width * current / max(total, 1))
    return '[' + '#' * filled + '-' * (width - filled) + ']'


def run_test(base, dry_run: bool = False):
    total_steps = len(TEST_STEPS)

    print()
    print('=' * 55)
    print('  UGV CHASSIS MOVEMENT TEST')
    print('=' * 55)
    if dry_run:
        print('  *** DRY-RUN MODE — no serial commands sent ***')
    print()

    for i, (desc, left, right, duration) in enumerate(TEST_STEPS, 1):
        print(f'  Step {i}/{total_steps}  {_bar(i, total_steps)}')
        print(f'  {desc}')
        print(f'  L={left:+.2f} m/s   R={right:+.2f} m/s   t={duration:.1f}s')

        if not dry_run:
            base.base_speed_ctrl(left, right)

        # Show a live countdown
        step = 0.1
        elapsed = 0.0
        while elapsed < duration:
            time.sleep(step)
            elapsed += step
            remaining = duration - elapsed
            bar = _bar(int(elapsed * 10), int(duration * 10))
            print(f'\r    {bar}  {remaining:.1f}s remaining   ', end='', flush=True)

        print()  # newline after progress bar

    # Final hard stop
    print('  Final stop — sending emergency stop (T=0)')
    if not dry_run:
        base.gimbal_emergency_stop()
        base.base_speed_ctrl(0, 0)

    print()
    print('  All steps completed successfully.')
    print('=' * 55)


def main():
    parser = argparse.ArgumentParser(description='Chassis movement test')
    parser.add_argument('--port',    default='/dev/ttyTHS1',
                        help='Serial port to the ESP32 (default: /dev/ttyTHS1)')
    parser.add_argument('--baud',    type=int, default=115200)
    parser.add_argument('--dry-run', action='store_true',
                        help='Print commands only, do not open serial or move robot')
    args = parser.parse_args()

    base = None

    if not args.dry_run:
        try:
            from base_ctrl import BaseController
        except ImportError as e:
            print(f'[ERROR] Could not import base_ctrl: {e}')
            print('        Make sure pyserial is installed:')
            print('          pip install pyserial')
            return 1

        print(f'[INFO] Opening serial port {args.port} at {args.baud} baud...')
        try:
            base = BaseController(args.port, args.baud)
            print('[INFO] Connected.')
        except Exception as e:
            print(f'[ERROR] Failed to open {args.port}: {e}')
            print('        Check the port with:  ls -l /dev/ttyTHS*')
            print('        Permission fix:        sudo usermod -a -G dialout $USER')
            return 1

        # Safety pause so operator can step back
        print()
        print('[WARN] Robot will move in 3 seconds. Step back!')
        for i in range(3, 0, -1):
            print(f'       {i}...')
            time.sleep(1)
    else:
        print('[INFO] Dry-run mode — skipping serial connection')

    try:
        run_test(base, dry_run=args.dry_run)
    except KeyboardInterrupt:
        print('\n[WARN] Interrupted by user!')
        if base is not None:
            print('[INFO] Sending stop...')
            try:
                base.base_speed_ctrl(0, 0)
                base.gimbal_emergency_stop()
            except Exception:
                pass
    finally:
        if base is not None:
            try:
                base.base_speed_ctrl(0, 0)
                base.gimbal_dev_close()
                print('[INFO] Serial port closed.')
            except Exception:
                pass

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
