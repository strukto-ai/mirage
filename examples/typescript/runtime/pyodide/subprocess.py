import shutil
import subprocess

print("which grep ->", shutil.which("grep"))

r = subprocess.run(
    ["grep", "-c", "ERROR", "/data/app.log"], capture_output=True, text=True
)
print("run grep -c ->", r.stdout.strip(), "exit", r.returncode)

out = subprocess.check_output(
    "cut -d' ' -f2 /data/app.log | sort | uniq -c | sort -rn",
    shell=True,
    text=True,
)
print("check_output(shell=True) ->")
print(out, end="")

p = subprocess.Popen(
    ["sort", "-r"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
)
sorted_out, _ = p.communicate("b\na\nc\n")
print("Popen sort -r ->", sorted_out.split())

subprocess.run("echo 'written by a child' > /data/child.txt", shell=True)
with open("/data/child.txt") as f:
    print("file a child wrote ->", f.read().strip())

try:
    subprocess.run(["sleep", "30"], timeout=0.5)
except subprocess.TimeoutExpired as e:
    print("timeout ->", type(e).__name__, "after", e.timeout, "s")

bg = subprocess.Popen(["sleep", "30"])
print("ps while a child runs ->")
subprocess.run(["ps"])
bg.kill()
print("killed child ->", bg.wait())

r = subprocess.run(["rm", "/ro/app.log"], capture_output=True, text=True)
print("rm on a read-only mount ->", r.returncode, r.stderr.strip())
