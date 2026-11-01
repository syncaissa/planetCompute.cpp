#!/usr/bin/env python3
"""Test "Email us a question" (POST /api/contact) on a STAGING copy of the website with CONTACT_DRY_RUN and Cloudflare's
always-pass Turnstile test keys (website/wrangler-staging.toml), so nothing is mailed. Run it from one computer:
the limits count per IP address, so the second run within a day ends in "limited".
   STAGING_URL=https://<your staging worker> python3 scripts/test_contact_form.py
Standard library only.
"""
import json, os, sys, time, urllib.error, urllib.request

B = os.environ.get("STAGING_URL", "").rstrip("/")
if not B:
    sys.exit(__doc__)
UA = {"User-Agent": "planetCompute-contact-test"}
ok = True


def call(path, body=None, origin=None):
    h = dict(UA)
    if body is not None:
        h["content-type"] = "application/json"
    if origin:
        h["Origin"] = origin
    rq = urllib.request.Request(B + path, data=None if body is None else json.dumps(body).encode(), headers=h)
    try:
        r = urllib.request.urlopen(rq, timeout=30)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name, detail, flush=True)


def token():
    return call("/api/contact/token")[1]["token"]


def form(t, **kw):
    b = {"first_name": "Test", "last_name": "Person", "email": "planetcompute.test@gmail.com",
         "question": "How do I contribute from a Linux server?", "website": "", "token": t, "turnstile": "XXXX.DUMMY.TOKEN.XXXX"}
    b.update(kw)
    return b


s, d = call("/api/contact/token")
check("1. a form token is handed out, with the Turnstile site key", s == 200 and d.get("token") and d.get("sitekey"), d.get("sitekey"))
t = token()
s, d = call("/api/contact", form(t))
check("2. sent at once (under 3 s) is refused", s == 400 and "quick" in d.get("error", ""), d)
time.sleep(3.5)
s, d = call("/api/contact", form(t, token="1792600000.0123456789abcdef." + "0" * 64))
check("3. a forged token is refused", s == 400 and "reload" in d.get("error", ""), d)
s, d = call("/api/contact", form(t, website="http://spam.example"))
check("4. honeypot filled: answered ok, nothing counted or sent", s == 200 and d.get("ok") and not d.get("dry_run"), d)
s, d = call("/api/contact", form(t, email="someone@mailinator.com"))
check("5. disposable email domain refused", s == 400 and "permanent" in d.get("error", ""), d)
s, d = call("/api/contact", form(t, email="someone@no-such-domain-planetcompute-test.invalid"))
check("6. a domain that cannot receive mail is refused", s == 400 and "cannot receive mail" in d.get("error", ""), d)
s, d = call("/api/contact", form(t, question="see http://a.example http://b.example http://c.example http://d.example now"))
check("7. more than three links refused", s == 400 and "three links" in d.get("error", ""), d)
s, d = call("/api/contact", form(t, first_name="http://spam.example"))
check("8. a link as a name refused", s == 400 and "name" in d.get("error", ""), d)
s, d = call("/api/contact", form(t), origin="https://evil.example")
check("9. a post from another web site refused", s == 403, d)
s, d = call("/api/contact", form(t))
check("10. a good question is accepted (dry run: not mailed)", s == 200 and d.get("ok"), d)
s, d = call("/api/contact", form(t))
check("11. the same form token cannot be used again", s == 400 and "already sent" in d.get("error", ""), d)
t2 = token(); time.sleep(3.5)
s, d = call("/api/contact", form(t2, email="planetcompute.test2@gmail.com"))
check("12. a second question in the minute is accepted", s == 200 and d.get("ok"), d)
t3 = token(); time.sleep(3.5)
s, d = call("/api/contact", form(t3, email="planetcompute.test3@gmail.com"))
check("13. a third in the same minute is refused (2 a minute, per IP)", s == 429 and "2 in a minute" in d.get("error", ""), d)
print("\nALL PASS" if ok else "\nSOME FAILED")
sys.exit(0 if ok else 1)
