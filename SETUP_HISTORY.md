# AI-Assisted Development Environment Setup History

This document records the setup process exactly as it happened, including
failed attempts and why they failed.

The eventual goal is to convert this into a Dockerfile.

---

# Goal

Create an isolated Linux development environment capable of running:

- Git
- Go
- git-bug
- RTK
- Claude Code

using Docker instead of a virtual machine.

---

# Step 1

Install Docker Desktop on macOS.

Verified:

```
docker run hello-world
```

Expected output:

```
Hello from Docker!
```

---

# Step 2

Launch Ubuntu.

Started from the project directory so it could be mounted into the container.

```
docker run -it \
    -v "$(pwd):/workspace" \
    -w /workspace \
    ubuntu:24.04 \
    bash
```

Container prompt became

```
root@...:/workspace#
```

Success.

---

# Step 3

Update package metadata.

```
apt update
```

---

# Step 4

Install Go.

```
apt install -y golang-go
```

Verify

```
go version
```

---

# Step 5

Attempt to install git-bug.

Initial attempt:

```
go install github.com/MichaelMure/git-bug@latest
```

FAILED.

Reason:

Ubuntu container did not contain trusted CA certificates.

Error:

```
tls: failed to verify certificate
```

---

# Step 6

Install certificates.

```
apt install -y ca-certificates
update-ca-certificates
```

Retry.

---

# Step 7

Retry git-bug install.

Still failed.

Reason:

git-bug repository contains Go replace directives.

`go install ...@latest` is not the supported installation method.

Changed strategy.

---

# Step 8

Install build tools.

```
apt install -y git make
```

Clone repository.

```
cd /tmp

git clone https://github.com/git-bug/git-bug.git

cd git-bug
```

Attempt

```
make install
```

FAILED.

Reason:

pnpm missing.

---

# Step 9

Install Node and npm.

```
apt install -y nodejs npm
```

Install pnpm.

```
npm install -g pnpm
```

FAILED.

Reason:

Ubuntu Node version (18) too old.

Current pnpm required Node 22.

---

# Step 10

Upgrade Node.

Installed Node 22.

(We used the NodeSource repository.)

Verified

```
node --version
```

Result

```
v22.x
```

---

# Step 11

Install pnpm again.

```
npm install -g pnpm
```

Initially

```
pnpm
```

still failed.

Reason:

Shell cached previous executable location.

Solution

```
hash -r
```

Verified

```
pnpm --version
```

Success.

---

# Step 12

Retry

```
make install
```

git-bug successfully built and installed.

Verified

```
git bug version
```

and

```
git-bug version
```

Both worked.

---

# Step 13

Return to project.

```
cd /workspace
```

Verify Git.

```
git status
```

Repository detected.

---

# Step 14

Install RTK.

```
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

Add to PATH.

```
export PATH="$HOME/.local/bin:$PATH"

hash -r
```

Verify.

```
rtk --version
```

```
rtk gain
```

Success.

---

# Step 15

Initialize RTK.

```
rtk init
```

Telemetry disabled.

Created

```
.rtk/

CLAUDE.md
```

Verified

```
ls -la

git status
```

---

# Current State

Working:

✅ Docker

✅ Ubuntu container

✅ Mounted project directory

✅ Git

✅ Go

✅ Node 22

✅ pnpm

✅ git-bug

✅ RTK

Pending:

- Install Claude Code
- Authenticate Claude
- Launch

```
claude --permission-mode acceptEdits
```

Then continue with the AI software team workflow.

---

# Future Work

Convert everything above into:

- Dockerfile
- README.md
- start-dev.sh

so setup becomes reproducible.
