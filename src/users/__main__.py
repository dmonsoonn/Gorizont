import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from . import due_users


def main() -> None:
    parser = argparse.ArgumentParser(description="Horizon per-user helpers")
    commands = parser.add_subparsers(dest="command", required=True)
    due = commands.add_parser("due", help="Print the GitHub Actions matrix of users due this hour")
    due.add_argument("-d", "--data-dir", default="data", metavar="PATH")
    due.add_argument("--hour", type=int, choices=range(24), default=None, metavar="HOUR")
    args = parser.parse_args()

    hour = datetime.now(timezone.utc).hour if args.hour is None else args.hour
    print(json.dumps({"include": due_users(Path(args.data_dir), hour)}))


if __name__ == "__main__":
    main()
