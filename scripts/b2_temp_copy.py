# Copy a file already in B2 to TEMP/<name> server side (no download), drop the older versions of TEMP/<name>, and set
# its note in TEMP/index.json.   python3 -I scripts/b2_temp_copy.py <source B2 name> <TEMP name> "<title>" "<note>"
# Reads the B2 key from ../.env (never printed).
import json, sys, urllib.request, base64, os
env = {}
for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.env')):
    l = l.strip()
    if '=' in l and not l.startswith('#'):
        k, v = l.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
def req(url, body=None, headers={}):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)))
a = req('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', headers={'Authorization': 'Basic ' + base64.b64encode((env['B2_KEY_ID'] + ':' + env['B2_APPLICATION_KEY']).encode()).decode()})
api, tok, dl = a['apiInfo']['storageApi']['apiUrl'], a['authorizationToken'], a['apiInfo']['storageApi']['downloadUrl']
H = {'Authorization': tok}; bucket = env['B2_BUCKET_NAME']
bid = req(api + '/b2api/v3/b2_list_buckets', {'accountId': a['accountId'], 'bucketName': bucket}, H)['buckets'][0]['bucketId']
src, name, title, note = sys.argv[1:5]
f = [x for x in req(api + '/b2api/v3/b2_list_file_names', {'bucketId': bid, 'prefix': src, 'maxFileCount': 5}, H)['files'] if x['fileName'] == src][0]
new = req(api + '/b2api/v3/b2_copy_file', {'sourceFileId': f['fileId'], 'fileName': 'TEMP/' + name}, H)
print('copied', src, '->', 'TEMP/' + name, new['contentLength'], 'bytes, sha1', new.get('contentSha1', '')[:12])
for v in req(api + '/b2api/v3/b2_list_file_versions', {'bucketId': bid, 'startFileName': 'TEMP/' + name, 'prefix': 'TEMP/' + name, 'maxFileCount': 50}, H)['files']:
    if v['fileName'] == 'TEMP/' + name and v['fileId'] != new['fileId']:
        req(api + '/b2api/v3/b2_delete_file_version', {'fileName': v['fileName'], 'fileId': v['fileId']}, H); print('deleted older version', v['fileId'][-10:])
index = json.load(urllib.request.urlopen(urllib.request.Request(f'{dl}/file/{bucket}/TEMP/index.json', headers=H)))
index['files'] = [x for x in index['files'] if x['name'] != name] + [{'name': name, 'title': title, 'note': note}]
up = req(api + '/b2api/v3/b2_get_upload_url', {'bucketId': bid}, H); body = json.dumps(index, indent=1).encode()
urllib.request.urlopen(urllib.request.Request(up['uploadUrl'], data=body, headers={'Authorization': up['authorizationToken'], 'X-Bz-File-Name': 'TEMP/index.json',
  'Content-Type': 'application/json', 'X-Bz-Content-Sha1': __import__('hashlib').sha1(body).hexdigest()}))
print('index:', len(index['files']), 'files')
