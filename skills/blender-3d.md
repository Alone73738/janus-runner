---
name: blender-3d
description: Make 3D renders / animations (MP4) with headless Blender on the cloud computer (CPU, no GPU)
---
1. Install ONCE per cloud computer (official build, NOT apt — apt is old and pulls a GUI stack). In ONE shell call (timeout 600):
   `sudo apt-get install -y -qq libxi6 libxkbcommon0 libxrender1 libgl1 libsm6 libxxf86vm1 libxfixes3 libegl1 >/dev/null; mkdir -p ~/.cache/blender && cd ~/.cache/blender && [ -x blender-4.2.3-linux-x64/blender ] || curl -sL https://download.blender.org/release/Blender4.2/blender-4.2.3-linux-x64.tar.xz | tar xJ; ~/.cache/blender/blender-4.2.3-linux-x64/blender -v | head -1`
   (~350 MB, stays in ~/.cache — never copy Blender into the workspace.)
2. Write the scene as a Python script in tmp/ (write_file), e.g. tmp/scene.py: use the factory cube/camera/light, keyframe rotation, then
   `scene.render.engine='CYCLES'; scene.cycles.device='CPU'; scene.cycles.samples=16; scene.cycles.use_denoising=False; scene.render.resolution_x=640; scene.render.resolution_y=640; scene.render.fps=24; scene.frame_end=fps*seconds`
   Output: render PNG frames to tmp/frames/f_#### (`scene.render.image_settings.file_format='PNG'; scene.render.filepath='//frames/f_'`) — more robust than Blender's own FFMPEG writer.
   Never use EEVEE / Workbench here: they need a GPU/OpenGL context and fail or hang headless. Cycles CPU works everywhere.
3. Render: `~/.cache/blender/blender-4.2.3-linux-x64/blender -b --factory-startup --python tmp/scene.py -a` (shell timeout 1800; 120 frames at 640px/16 samples take ~1–4 min).
4. Encode: `ffmpeg -y -framerate 24 -i tmp/frames/f_%04d.png -c:v libx264 -pix_fmt yuv420p -movflags +faststart NAME.mp4` at the TOP LEVEL, then send_file NAME.mp4. Check with ffprobe (duration ≈ seconds) before you say it is done.
