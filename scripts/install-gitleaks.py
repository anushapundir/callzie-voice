#!/usr/bin/env python3
"""Explicitly install a checksum-pinned official Gitleaks release into ignored bin/."""
import hashlib
import io
from pathlib import Path
import platform
import tarfile
import urllib.request

VERSION = '8.30.1'
HASHES = {
    'darwin_arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
    'darwin_x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
    'linux_arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
    'linux_x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
}


def main():
    system = platform.system().lower()
    machine = platform.machine().lower()
    architecture = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(machine)
    target = f'{system}_{architecture}'
    if target not in HASHES:
        raise SystemExit('Use WSL or install Gitleaks from its official release page for this platform.')
    url = f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_{target}.tar.gz'
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = response.read()
    if hashlib.sha256(archive).hexdigest() != HASHES[target]:
        raise SystemExit('Gitleaks archive checksum mismatch; nothing was installed.')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        member = tar.getmember('gitleaks')
        if not member.isfile():
            raise SystemExit('Unexpected scanner archive entry.')
        binary = tar.extractfile(member).read()
    destination = Path(__file__).resolve().parents[1] / 'bin' / 'gitleaks'
    destination.parent.mkdir(exist_ok=True)
    destination.write_bytes(binary)
    destination.chmod(0o755)
    print(f'Installed checksum-verified Gitleaks {VERSION} in ignored bin/.')


if __name__ == '__main__':
    main()
