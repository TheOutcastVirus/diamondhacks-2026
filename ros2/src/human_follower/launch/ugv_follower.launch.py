"""
ugv_follower.launch.py

Launches the full human-follower stack:
  1. camera_publisher_node  — reads USB camera, publishes /camera/image_raw
  2. human_follower_node    — MobileNet SSD detection + BaseController hardware control
                              + optional annotated viewer window

Usage:
    ros2 launch human_follower ugv_follower.launch.py
    ros2 launch human_follower ugv_follower.launch.py show_viewer:=true
    ros2 launch human_follower ugv_follower.launch.py show_viewer:=true camera_device:=1
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():

    params_file_arg = DeclareLaunchArgument(
        'params_file',
        default_value=PathJoinSubstitution([
            FindPackageShare('human_follower'), 'config', 'params.yaml',
        ]),
        description='Path to the shared parameters file',
    )

    camera_device_arg = DeclareLaunchArgument(
        'camera_device',
        default_value='0',
        description='Camera device index (0=/dev/video0, 1=/dev/video1)',
    )

    show_viewer_arg = DeclareLaunchArgument(
        'show_viewer',
        default_value='true',
        description='Open annotated OpenCV window (true/false)',
    )

    camera_node = Node(
        package='human_follower',
        executable='camera_publisher_node',
        name='camera_publisher_node',
        output='screen',
        parameters=[
            LaunchConfiguration('params_file'),
            {'camera_device': LaunchConfiguration('camera_device')},
        ],
    )

    follower_node = Node(
        package='human_follower',
        executable='human_follower_node',
        name='human_follower_node',
        output='screen',
        parameters=[
            LaunchConfiguration('params_file'),
            {'show_viewer': LaunchConfiguration('show_viewer')},
        ],
    )

    return LaunchDescription([
        params_file_arg,
        camera_device_arg,
        show_viewer_arg,
        camera_node,
        follower_node,
    ])
