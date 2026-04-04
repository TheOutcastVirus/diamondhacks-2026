from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():

    params_file_arg = DeclareLaunchArgument(
        'params_file',
        default_value=PathJoinSubstitution([
            FindPackageShare('human_follower'),
            'config',
            'params.yaml',
        ]),
        description='Full path to the ROS2 parameters file for human_follower_node',
    )

    human_follower_node = Node(
        package='human_follower',
        executable='human_follower_node',
        name='human_follower_node',
        output='screen',
        parameters=[LaunchConfiguration('params_file')],
        remappings=[
            # Remap these if your robot uses different topic names
            # ('/camera/image_raw', '/your/camera/topic'),
            # ('/cmd_vel',          '/your/cmd_vel/topic'),
            # ('/camera/pan_tilt',  '/your/gimbal/topic'),
        ],
    )

    return LaunchDescription([
        params_file_arg,
        human_follower_node,
    ])
