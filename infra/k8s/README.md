# MOA K3s 배포

최초 배포는 `00-namespace.yaml`, Registry Secret/moa-auth 생성, `10-storage.yaml`, `20-app.yaml`, `30-ingress.yaml`, `40-networkpolicy.yaml` 순서다. Secret 실제 값은 저장소에 넣지 않는다.

운영 주소: https://moa.delvrio.com · namespace: moa.

이미지 빌드/업로드: `docker build -t gitea.delvrio.com/hyungjin7/moa/app:<고유태그> .` 후 승인된 레지스트리 자격으로 push한다. `20-app.yaml`의 app/init image를 새 digest로 함께 갱신하고 서버 dry-run 후 apply한다. `kubectl -n moa rollout status deploy/moa`와 certificate Ready를 확인한다. Git push만으로 배포하는 CI는 아직 구성하지 않았다.

[SSO 설계·계정 승인·운영 절차](../../docs/2026-11-08_MOA_Keycloak_SSO_설계및운영절차.md)를 참고한다.
