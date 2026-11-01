#!/usr/bin/env python3
"""Make a PlanetCompute user an admin (sets IsAdmin = True on their profile), or remove admin rights.

Usage:
    python makeThisUserAdmin.py someone@example.com          # by email address
    python makeThisUserAdmin.py 0123456789ab                 # by 12-hex user ID
    python makeThisUserAdmin.py someone@example.com --remove # set IsAdmin = False

Reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION and DYNAMODB_TABLE_PREFIX from the environment
or ./.env. Needs boto3 (pip install boto3). The user must already exist: they sign in once at
https://planetcompute.ai first. The admin page is https://planetcompute.ai/admin
"""
import argparse
import datetime
import os
import pathlib
import re
import sys


def load_dotenv(path=pathlib.Path(__file__).resolve().parent / ".env"):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("who", help="email address or 12-hex user ID")
    ap.add_argument("--remove", action="store_true", help="remove admin rights instead")
    args = ap.parse_args()

    load_dotenv()
    import boto3
    from boto3.dynamodb.conditions import Key  # noqa: F401  (imported so boto3 resource types load)

    prefix = os.environ.get("DYNAMODB_TABLE_PREFIX", "planetcompute-ai-")
    table = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1")).Table(prefix + "user")

    who = args.who.strip()
    if re.fullmatch(r"[0-9a-fA-F]{12}", who):
        user_id = who.lower()
    elif "@" in who:
        item = table.get_item(Key={"pk": "EMAIL#" + who.lower(), "sk": "EMAIL"}, ConsistentRead=True).get("Item")
        if not item:
            sys.exit(f"No account uses {who}. Ask them to sign in once at https://planetcompute.ai first.")
        user_id = item["user_id"]
    else:
        sys.exit("Give an email address or a 12-hex user ID.")

    profile = table.get_item(Key={"pk": "USER#" + user_id, "sk": "PROFILE"}, ConsistentRead=True).get("Item")
    if not profile:
        sys.exit(f"No user with ID {user_id}.")

    value = not args.remove
    table.update_item(Key={"pk": "USER#" + user_id, "sk": "PROFILE"},
                      # admin_pk puts the profile in the sparse "admins" index the admin page lists
                      UpdateExpression="SET IsAdmin = :v, admin_changed_at = :t" + (", admin_pk = :a" if value else " REMOVE admin_pk"),
                      ExpressionAttributeValues={":v": value,
                                                 ":t": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                                 **({":a": "ADMIN"} if value else {})})
    name = " ".join(x for x in (profile.get("first_name"), profile.get("last_name")) if x) or profile.get("primary_email")
    print(f"{name} ({user_id}, {profile.get('primary_email')}): IsAdmin = {value}")
    if value:
        print("Open https://planetcompute.ai/admin (sign in first if needed).")


if __name__ == "__main__":
    main()
