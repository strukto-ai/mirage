CDPATH= cd -- "$1" || exit 126
shift
exec "$@"
