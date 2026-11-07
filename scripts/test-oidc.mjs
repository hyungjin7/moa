import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-oidc-test-'))
try {
  const cfg = path.join(tmp, 'openssl.cnf')
  fs.writeFileSync(cfg, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'), '-days', '1', '-config', cfg], { stdio: 'ignore' })
  const result = spawnSync(process.execPath, ['--test', 'tests/oidc/security.test.mjs'], { stdio: 'inherit',
    env: { ...process.env, MOA_TEST_TLS_DIR: tmp, NODE_EXTRA_CA_CERTS: path.join(tmp, 'cert.pem') } })
  process.exitCode = result.status ?? 1
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }
