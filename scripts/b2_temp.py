# Upload files to B2 TEMP/ (shown at https://planetcompute.ai/temp/) and keep TEMP/index.json (name, title, note).
#   python3 -I scripts/b2_temp.py <entries.json>   entries: [{"path": local file, "name": name in TEMP/, "title", "note"}]
# Reads the B2 key from ../.env (never printed).
import json, sys, urllib.request, base64, hashlib, mimetypes
env = {}
for l in open(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', '..', '.env')):
    l = l.strip()
    if '=' in l and not l.startswith('#'):
        k, v = l.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
def req(url, data=None, headers={}):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers)))
a = req('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', headers={'Authorization': 'Basic ' + base64.b64encode((env['B2_KEY_ID'] + ':' + env['B2_APPLICATION_KEY']).encode()).decode()})
api, tok, dl = a['apiInfo']['storageApi']['apiUrl'], a['authorizationToken'], a['apiInfo']['storageApi']['downloadUrl']
bucket = env['B2_BUCKET_NAME']
bid = req(api + '/b2api/v3/b2_list_buckets', json.dumps({'accountId': a['accountId'], 'bucketName': bucket}).encode(), {'Authorization': tok})['buckets'][0]['bucketId']
def put(name, data, ctype):
    up = req(api + '/b2api/v3/b2_get_upload_url', json.dumps({'bucketId': bid}).encode(), {'Authorization': tok})
    urllib.request.urlopen(urllib.request.Request(up['uploadUrl'], data=data, headers={'Authorization': up['authorizationToken'], 'X-Bz-File-Name': 'TEMP/' + name, 'Content-Type': ctype, 'X-Bz-Content-Sha1': hashlib.sha1(data).hexdigest()}))
try:
    index = json.load(urllib.request.urlopen(urllib.request.Request(f'{dl}/file/{bucket}/TEMP/index.json', headers={'Authorization': tok})))
except Exception:
    index = {'files': []}
entries = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else []
for e in entries:
    data = open(e['path'], 'rb').read()
    put(e['name'], data, mimetypes.guess_type(e['name'])[0] or 'application/octet-stream')
    index['files'] = [f for f in index['files'] if f['name'] != e['name']] + [{k: e[k] for k in ('name', 'title', 'note') if e.get(k)}]
    print('uploaded TEMP/' + e['name'], len(data), 'bytes')
put('index.json', json.dumps(index, indent=1).encode(), 'application/json')
print('index:', len(index['files']), 'files')
