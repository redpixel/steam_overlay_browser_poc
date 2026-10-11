#!/bin/sh
# Regenerates patches/spacewar.patch from the original Spacewar files in the Steamworks SDK zip
# and the working sdk/ files, then checks it applies to the originals and reproduces the working
# files byte for byte. Run from Git Bash:
#   sh tools/regen_patch.sh C:/Downloads/steamworks_sdk_162.zip
# The Spacewar files are CRLF: the script stops if a working file has a bare LF line.
ZIP="$1"
[ -f "$ZIP" ] || { echo "usage: sh tools/regen_patch.sh <steamworks_sdk_162.zip>"; exit 1; }
R=$(cd "$(dirname "$0")/.." && pwd)
P=$(mktemp -d)
trap 'rm -rf "$P"' EXIT
FILES="OverlayExamples.cpp OverlayExamples.h SpaceWarClient.cpp SpaceWarClient.h gameenginewin32.cpp"

python -I -c "
import sys
root = sys.argv[1]
for f in sys.argv[2:]:
    b = open(root + '/sdk/steamworksexample/' + f, 'rb').read()
    assert b.count(b'\r\n') == b.count(b'\n'), f + ' is not all CRLF'
print('line endings: all CRLF')
" "$R" $FILES || exit 1

# a = originals from the zip, c = working files
python -I -c "
import sys, zipfile, os
z = zipfile.ZipFile(sys.argv[1])
for f in sys.argv[3:]:
    out = os.path.join(sys.argv[2], 'a', 'sdk', 'steamworksexample', f)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'wb').write(z.read('sdk/steamworksexample/' + f))
" "$ZIP" "$P" $FILES || exit 1
mkdir -p "$P/c/sdk/steamworksexample"
for f in $FILES; do cp "$R/sdk/steamworksexample/$f" "$P/c/sdk/steamworksexample/"; done

cd "$P" && git -c core.autocrlf=false diff --no-index --binary a c > raw.patch
python -I -c "
import sys
out = []
for line in open(sys.argv[1], 'rb').read().split(b'\n'):
    if line.startswith(b'diff --git a/a/'): line = line.replace(b'diff --git a/a/', b'diff --git a/', 1).replace(b' b/c/', b' b/', 1)
    elif line.startswith(b'--- a/a/'): line = b'--- a/' + line[8:]
    elif line.startswith(b'+++ b/c/'): line = b'+++ b/' + line[8:]
    out.append(line)
open(sys.argv[2], 'wb').write(b'\n'.join(out))
" "$P/raw.patch" "$R/patches/spacewar.patch"
git -c core.autocrlf=false diff --no-index --stat a c | tail -1

T="$P/verify"; mkdir -p "$T"; cp -r "$P/a/sdk" "$T/"
cd "$T" && git -c core.autocrlf=false apply --whitespace=nowarn "$R/patches/spacewar.patch" || exit 1
for f in $FILES; do cmp -s "sdk/steamworksexample/$f" "$R/sdk/steamworksexample/$f" || { echo "DIFF: $f"; exit 1; }; done
echo "patch applies and reproduces all 5 files"
