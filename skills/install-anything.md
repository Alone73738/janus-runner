---
name: install-anything
description: Install and use any tool on the cloud computer (apt, pip, npm, a release binary) and remember it for next time
---
1. Check first: `which TOOL || TOOL --version`.
2. apt packages → install_packages {apt:[...]}; Python libs → install_packages {pip:[...]}; Node CLIs → install_packages {npm:[...]}. They are remembered and reinstalled automatically on a fresh cloud computer.
3. A single binary from GitHub releases: shell `mkdir -p ~/.local/bin && curl -L -o ~/.local/bin/NAME URL && chmod +x ~/.local/bin/NAME` (~/.local/bin is on PATH and kept in the workspace).
4. Run it with shell; read the error; fix; repeat. Big downloads/models go under ~/.cache (not kept between chats).
5. Results the user should get → top level of the workspace (or send_file). One short line per finished step.
