#!/usr/bin/env python3
"""Prompt locally; send the secret through SSH stdin, never shell arguments or logs."""
import base64
import getpass
import json
import subprocess

value = getpass.getpass('Keycloak moa-web Client Secret (입력 내용은 보이지 않습니다): ').strip()
if not value:
    raise SystemExit('빈 값은 적용하지 않았습니다.')
patch = {'data': {'MOA_OIDC_CLIENT_SECRET': base64.b64encode(value.encode()).decode()}}
command = ['ssh', '-o', 'BatchMode=yes', 'hyungjin',
    'K3S_CONFIG_FILE=/dev/null KUBECONFIG=/home/hyungjin/.kube/k3s-vip.yaml kubectl -n moa patch secret moa-auth --type merge --patch-file /dev/stdin']
r = subprocess.run(command, input=json.dumps(patch), text=True, capture_output=True)
if r.returncode:
    raise SystemExit('적용 실패: SSH 연결과 moa-auth Secret 존재 여부를 확인하세요. 비밀 값은 출력하지 않았습니다.')
print('moa-auth에 안전하게 저장했습니다. 채팅에는 "Client Secret 입력 완료"만 알려주세요.')
