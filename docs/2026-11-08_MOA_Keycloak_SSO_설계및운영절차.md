# MOA 자체 로그인 병행 및 Keycloak SSO

## 적용 범위

- 서비스/namespace: `moa`, 공개 주소: `https://moa.delvrio.com`.
- 기존 Team account·Owner password·초대·권한 관리는 유지한다. 로그인 폼 아래에 `Keycloak 로그인` 버튼을 추가한다.
- Keycloak `delvrio-internal` Realm, confidential Client `moa-web`, Authorization Code + PKCE(S256).
- ID 토큰은 openid-client 6으로 서명(JWKS)·issuer·audience·만료·nonce를 검증한다. state와 브라우저별 HttpOnly 거래 쿠키를 대조하고 거래는 10분 이내 1회만 사용한다.
- 다음 페이지는 같은 MOA origin의 내부 페이지로 제한한다.

## 사용자 연결 및 권한

1. 관리자가 기존 초대 기능으로 MOA 계정을 준비한다. Keycloak 계정의 이메일과 같아도 자동 연결하지 않는다.
2. 사용자가 Keycloak 로그인 버튼으로 인증한다. 미연결 사용자는 승인 대기 안내로 돌아오며 MOA 세션은 발행하지 않는다.
3. MOA 관리자: Workspace menu → Settings → Team members → Keycloak 계정 연결.
4. 사용자에게 Keycloak 이름·이메일·사용자 식별값을 확인한 뒤, 기존 MOA 계정을 골라 `연결 승인`한다. 이메일 일치만으로 소유권을 판단하지 않는다.
5. 사용자가 다시 Keycloak으로 로그인한다. 같은 MOA 계정 ID를 사용하므로 기존 프로젝트 권한과 개인 pin을 유지한다.
6. 연결 해제·계정 비활성화·삭제·비밀번호 재설정은 Node API의 기존 사용자 검사와 서버 세션 검사에서 즉시 반영된다. 사용자 재활성화는 아직 만료되지 않은 세션을 다시 유효하게 할 수 있으므로 영구 회수는 연결 해제로 처리한다.

SSO 사용자도 MOA 로컬 역할(admin/member)과 프로젝트 목록을 따른다. Keycloak role·그룹은 관리자 권한으로 자동 변환하지 않는다. 기본 owner 비밀번호는 Keycloak 장애 시 관리자 접속 경로다.

## 세션·로그아웃

- SSO 세션: 8시간 고정 만료, 로그인 시 새 세션. refresh token·자동 30일 갱신은 구현하지 않는다.
- 서버 `oidc.json`: 거래·승인 대기·issuer+sub→MOA 사용자 바인딩·서버 세션. ID 토큰은 MOA_SECRET 유래 AES-256-GCM 키로 암호화한다. access/refresh token은 보관하지 않는다.
- 브라우저: MOA 서명 쿠키와 불투명 서버 세션 식별값만 보관한다. provider 토큰은 쿠키/로컬 저장소에 전달하지 않는다.
- MOA 로그아웃은 서버 세션을 먼저 삭제하고 Keycloak RP-initiated logout으로 이동한다. IdP 장애 시에도 로컬 세션 삭제와 자체 로그인은 가능하다.
- Keycloak에서만 별도로 세션을 종료한 경우, MOA 세션의 즉시 회수(back-channel logout)는 구현하지 않았다. MOA 계정을 비활성화/연결 해제하거나 8시간 만료를 따른다.
- 기존 자체 계정: 원래 7일, Owner: 원래 30일 정책을 유지한다.

## Keycloak 등록

`infra/keycloak/moa-web.json`을 `delvrio-internal` Realm에 import하거나 동일 값을 수동 입력한다.

- Client ID `moa-web`, client authentication ON, standard flow ON.
- implicit/direct access grants/service accounts OFF.
- redirect URI: `https://moa.delvrio.com/api/oidc/callback` (와일드카드 금지).
- post logout URI: `https://moa.delvrio.com/login`.
- web origin/root/home: `https://moa.delvrio.com`.
- PKCE S256, 기본 scope profile/email.

Client Secret은 채팅·Git·셸 인자에 넣지 않는다. Mac에서 `python3 scripts/configure-oidc-secret.py` 실행 후 비공개 프롬프트로 입력하면 SSH stdin으로 Kubernetes Secret에 저장한다. 변경 후 Pod 재시작이 필요하다. MOA issuer·redirect는 HTTPS로 고정하고 Keycloak의 기존 공개/관리자 접근 정책은 수정하지 않는다.

## 최초 자체 관리자 비밀번호

초기 무작위 owner 비밀번호는 서버의 비공개 파일에 보관한다. Mac으로 복사하지 않는다.

사용자가 `python3 scripts/set-k3s-owner-password.py`를 실행하면 본인이 정한 비밀번호의 scrypt 해시만 전송해 `moa-auth`를 갱신하고 Deployment를 재시작한다. 이메일 없이 Owner password 모드로 로그인한다. 평문 비밀번호는 전송·저장·출력하지 않는다.

## K3s 및 저장소

- 단일 Next.js 프로세스/Pod, Deployment Recreate. JSON 저장소의 read-modify-write는 동기 처리하며 서로 다른 프로세스의 동시 쓰기는 지원하지 않는다. 임의 scale-out 금지.
- PVC `moa-data`, `nfs-hdd`, 10Gi 요청. 문서·계정·공유 링크·pin·OIDC 상태는 `/data`에 유지한다.
- init container는 없는 guide만 초기화한다. 기존 문서를 덮어쓰지 않는다. `/app/public`은 같은 PVC의 public 하위 폴더를 마운트한다.
- browse root `/data/projects`: Mac 전체 홈이나 다른 서비스의 볼륨을 노출하지 않는다. Mac 문서는 서버로 명시적으로 동기화해야 한다.
- Ingress: Traefik + letsencrypt-prod, TLS Secret `moa-tls`.
- NetworkPolicy: 앱 포트는 Traefik에서만 허용. OIDC는 기존 공개 HTTPS 경로로 통신한다.
- root 권한 없는 uid/gid 1000, capabilities 제거, 권한 상승 차단. 이미지 digest 고정.
- MOA_SECRET·MOA_PASSWORD_HASH·MOA_OIDC_CLIENT_SECRET은 `moa/moa-auth`에만 저장한다. 레지스트리 pull credential도 Secret으로 보관한다.
- Claude Code CLI는 컨테이너에 설치하지 않았다. 문서 열람·자체 로그인·SSO와 별도로 추가 구성할 기능이다.

## 검증 및 되돌리기

`npm ci && npm run test:oidc && npm run build`.

14개 OIDC 테스트는 임시 HTTPS provider와 실제 RSA 서명 토큰으로 정상/오류 nonce·audience·issuer·서명·만료, PKCE, state/browser mismatch, replay, 외부 redirect, 동일 이메일 자동 연결 금지, 관리자 승인 권한/Origin 검사, 로컬 사용자 비활성화/연결 해제/로그아웃을 확인한다. 비밀은 테스트용 합성 값이며 임시 TLS 키는 종료 시 삭제한다.

브라우저에서는 자체 계정 로그인·문서 목록·Settings의 승인 UI와 운영 로그인 버튼을 검수한다. 실제 사용자 Keycloak 인증과 최종 계정 연결은 사용자 확인 후 별도 기록한다.

SSO만 중단하려면 `MOA_OIDC_ENABLED=0`으로 재배포한다(신규 SSO 진입 중단; 기존 세션은 만료/연결 해제로 회수). 자체 로그인과 PVC 데이터는 유지한다. 전체 배포 롤백은 이전 이미지 digest로 app/init image를 함께 되돌린다. PVC·moa-auth는 삭제하지 않는다.

영구 볼륨은 백업이 아니다. `/data`와 `moa-auth`의 외부 백업 및 복구 시험은 별도 운영 항목이며 이번 배포에서 완료했다고 간주하지 않는다.
