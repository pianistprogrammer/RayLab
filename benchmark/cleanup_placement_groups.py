#!/usr/bin/env python3
"""Remove leaked Ray placement groups by id."""

from __future__ import annotations

import argparse
import os

os.environ.setdefault("RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER", "1")

import ray
from ray._raylet import PlacementGroupID
from ray.util.placement_group import PlacementGroup, remove_placement_group


def main() -> None:
    parser = argparse.ArgumentParser(description="Remove Ray placement groups by hex id.")
    parser.add_argument("ids", nargs="+", help="Placement group ids to remove.")
    parser.add_argument("--address", default="auto", help="Ray address.")
    args = parser.parse_args()

    ray.init(address=args.address)
    for item in args.ids:
        remove_placement_group(PlacementGroup(PlacementGroupID.from_hex(item)))
        print(f"removed {item}")
    ray.shutdown()


if __name__ == "__main__":
    main()
