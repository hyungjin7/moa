#!/usr/bin/env python3
"""Set the native owner password from local private input; send only its scrypt hash."""
import base64
import getpass
import shutil
import json
import secrets
import subprocess

password = getpass.getpass('MOA Owner 새 비밀번호 (12자 이상, 입력은 보이지 않습니다): ')
if len(password) < 12:
    raise SystemExit('12자 이상을 사용하세요. 변경하지 않았습니다.')
if password != getpass.getpass('새 비밀번호 확인: '):
    raise SystemExit('비밀번호가 다릅니다. 변경하지 않았습니다.')
salt = secrets.token_hex(16)
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js를 찾지 못했습니다. Node가 설치된 터미널에서 다시 실행하세요.')
# macOS system Python may not provide hashlib.scrypt; use Node's native crypto.
code = "let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const p=JSON.parse(input);process.stdout.write(require('node:crypto').scryptSync(p.password,p.salt,32).toString('hex'))})"
r = subprocess.run([node, '-e', code], input=json.dumps({'password': password, 'salt': salt}), text=True, capture_output=True)
if r.returncode or len(r.stdout) != 64:
    raise SystemExit('비밀번호 해시 생성 실패. 변경하지 않았습니다.')
hashed = r.stdout
patch = {'data': {'MOA_PASSWORD_HASH': base64.b64encode(f'scrypt:{salt}:{hashed}'.encode()).decode()}}
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', 'hyungjin',
    'K3S_CONFIG_FILE=/dev/null KUBECONFIG=/home/hyungjin/.kube/k3s-vip.yaml kubectl -n moa patch secret moa-auth --type merge --patch-file /dev/stdin'],
    input=json.dumps(patch), text=True, capture_output=True)
if r.returncode:
    raise SystemExit('변경 실패: 비밀번호나 해시는 출력하지 않았습니다. SSH와 moa-auth를 확인하세요.')
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', 'hyungjin',
    'K3S_CONFIG_FILE=/dev/null KUBECONFIG=/home/hyungjin/.kube/k3s-vip.yaml kubectl -n moa rollout restart deployment/moa && K3S_CONFIG_FILE=/dev/null KUBECONFIG=/home/hyungjin/.kube/k3s-vip.yaml kubectl -n moa rollout status deployment/moa --timeout=120s'],
    text=True, capture_output=True)
if r.returncode:
    raise SystemExit('Secret 변경은 완료됐습니다. rollout 상태 확인이 필요합니다.')
print('설정 완료. https://moa.delvrio.com/login → Owner password를 선택해 방금 설정한 비밀번호로 로그인하세요.')
