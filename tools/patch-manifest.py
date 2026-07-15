#!/usr/bin/env python3
"""Adds the permissions the app needs to the generated AndroidManifest.

`npx cap add android` regenerates the manifest from scratch, so we patch it on
every build rather than committing the android/ folder.
"""
import sys

PATH = 'android/app/src/main/AndroidManifest.xml'

PERMS = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.CAMERA',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.SCHEDULE_EXACT_ALARM',
]


def main():
    src = open(PATH).read()
    missing = [p for p in PERMS if p not in src]
    if not missing:
        print('All permissions already present.')
        return
    block = ''.join('    <uses-permission android:name="%s" />\n' % p for p in missing)
    src = src.replace('</manifest>', block + '</manifest>')
    open(PATH, 'w').write(src)
    print('Added:\n' + block)


if __name__ == '__main__':
    sys.exit(main())
