from setuptools import find_packages, setup
import os
from glob import glob

package_name = 'human_follower'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'),
            glob('launch/*.launch.py')),
        (os.path.join('share', package_name, 'config'),
            glob('config/*.yaml')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='ugv-bot',
    maintainer_email='todo@example.com',
    description='Human follower node for a differential drive tracked robot',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'human_follower_node = human_follower.human_follower_node:main',
            'camera_publisher_node = human_follower.camera_publisher_node:main',
        ],
    },
)
