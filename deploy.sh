# deploy sequentially, abort on the first failure
for d in functions/*; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  echo "=== Deploying function: $name ==="
  supabase functions deploy "$name" || { echo "Deploy failed for $name"; exit 1; }
done