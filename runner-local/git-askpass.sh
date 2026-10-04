#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "${GREMLINS_GIT_USERNAME:-x-access-token}" ;;
  *Password*) printf '%s\n' "$GREMLINS_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
