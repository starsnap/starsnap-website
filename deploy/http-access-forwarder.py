"""Forward Caddy access metadata to the StarSnap Log ingestion API."""

from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
from http.client import HTTPConnection, HTTPException
from ipaddress import IPv4Address
import json
from pathlib import Path
import re
import time
from urllib.parse import unquote


SPOOL = Path('/var/log/starsnap-http')
CURSOR = SPOOL / 'cursor.json'
SECRET = Path('/run/secrets/hub-ingest-secret')
PATH_CHARS = re.compile(r"/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*")
PRIVATE_ROUTE = re.compile(r'(?i)(/(?:invite|share|shared|token|verify|confirmation|reset-password)/)[^/]+')
PRIVATE_SEGMENT = re.compile(r'(?i)(?<=/)(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|[a-z0-9_-]{32,}|\d{4,}|[^/]*@[^/]*)(?=/|$)')
HOSTS = {
    'starsnap.kr', 'www.starsnap.kr', 'sns.starsnap.kr', 'chat.starsnap.kr',
    'erp.starsnap.kr', 'bible.starsnap.kr', 'admin.starsnap.kr', 'log.starsnap.kr',
}


def access_payload(record):
    request = record['request']
    host = request['host'].partition(':')[0].lower()
    status = int(record['status'])
    if host not in HOSTS or not 100 <= status <= 599:
        return None
    raw_path = request['uri'].partition('?')[0]
    path = unquote(raw_path)
    if len(path) > 255 or not PATH_CHARS.fullmatch(path) or path.count('/') != raw_path.count('/'):
        path = '/redacted'
    path = PRIVATE_SEGMENT.sub(':id', PRIVATE_ROUTE.sub(r'\1:redacted', path))
    try:
        ip = str(IPv4Address(request.get('client_ip', '')))
    except ValueError:
        # shortcut: Hub currently accepts IPv4 only, use native IPv6 when its ingest contract supports it.
        ip = '0.0.0.0'
    method = request['method']
    duration = max(0, float(record['duration']))
    return {
        'sourceService': host,
        'path': path,
        'method': method if re.fullmatch('[A-Z]{1,16}', method) else 'OTHER',
        'statusCode': str(status),
        'ipAddress': ip,
        'responseTimeMs': duration * 1000,
        'requestedAt': datetime.fromtimestamp(float(record['ts']) - duration, timezone.utc).isoformat(),
    }


def forward(connection, secret, payload):
    connection.request('POST', '/api/server-logs', json.dumps(payload, allow_nan=False), {
        'Content-Type': 'application/json',
        'X-Hub-Log-Secret': secret,
    })
    with connection.getresponse() as response:
        response.read()
        if response.status in (400, 413, 422):
            print(f'Hub rejected an access record ({response.status})', flush=True)
        elif response.status != 201:
            raise HTTPException(f'Hub returned {response.status}')


def drain(secret, offsets):
    current = set()
    files = sorted(SPOOL.glob('access-*.log')) + [SPOOL / 'access.log']
    with closing(HTTPConnection('starsnap-log-server', 8081, timeout=5)) as connection:
        for path in files:
            try:
                stream = path.open('rb')
            except FileNotFoundError:
                continue
            with stream:
                first = stream.readline()
                if not first.endswith(b'\n'):
                    continue
                key = sha256(first).hexdigest()
                current.add(key)
                stream.seek(offsets.get(key, 0))
                for line in iter(stream.readline, b''):
                    if not line.endswith(b'\n'):
                        break
                    try:
                        payload = access_payload(json.loads(line))
                    except (KeyError, TypeError, ValueError, OverflowError):
                        payload = None
                        print('Skipped malformed Caddy access record', flush=True)
                    if payload is not None:
                        forward(connection, secret, payload)
                    offsets[key] = stream.tell()
    return {key: offsets[key] for key in current if key in offsets}


def main():
    secret = SECRET.read_text().strip()
    if not secret:
        raise RuntimeError('Missing Hub ingest secret')
    offsets = json.loads(CURSOR.read_text()) if CURSOR.exists() else {}
    retry_delay = 1
    while True:
        previous = offsets.copy()
        try:
            offsets = drain(secret, offsets)
            retry_delay = 1
        except (OSError, HTTPException) as error:
            print(f'Access ingestion will retry ({type(error).__name__})', flush=True)
            retry_delay = min(retry_delay * 2, 30)
        if offsets != previous:
            # shortcut: a crash can replay the uncheckpointed batch, add ingest idempotency if required.
            pending = CURSOR.with_suffix('.tmp')
            pending.write_text(json.dumps(offsets))
            pending.replace(CURSOR)
        time.sleep(retry_delay)


if __name__ == '__main__':
    main()
