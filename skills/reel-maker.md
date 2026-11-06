---
name: reel-maker
description: Turn any video into a vertical 9:16 reel with burned-in captions and background music (ffmpeg + faster-whisper)
---
1. Input: the user's attached video is in ./inputs/ (or download_file the link first). Probe it: `ffprobe -v error -show_entries stream=codec_type,width,height,duration -of json in.mp4`.
2. Tools: `ffmpeg -version` (install_packages apt ["ffmpeg"] only if missing). Captions: install_packages pip ["faster-whisper"].
3. Captions (skip if the video has no speech): python
   from faster_whisper import WhisperModel; m = WhisperModel("base", device="cpu", compute_type="int8")
   segs, info = m.transcribe("inputs/IN.mp4", vad_filter=True)  # language auto; Hindi speech: write Roman Hinglish if the user writes Roman
   write captions.srt (index, "HH:MM:SS,mmm --> HH:MM:SS,mmm", text ≤ 42 chars per line).
4. Music: if the user gave none, synthesize a soft royalty-free bed (no copyright risk):
   ffmpeg -f lavfi -i "sine=f=196:d=D" -f lavfi -i "sine=f=247:d=D" -f lavfi -i "sine=f=294:d=D" -filter_complex "amix=inputs=3,volume=0.25,afade=t=in:d=1,afade=t=out:st=D-1.5:d=1.5,aecho=0.8:0.7:60:0.3" -c:a aac music.m4a   (D = video duration)
5. Render 1080x1920 (blurred background so nothing is cut off):
   ffmpeg -y -i inputs/IN.mp4 -i music.m4a -filter_complex "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[bg];[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,subtitles=captions.srt:force_style='FontName=DejaVu Sans,Fontsize=13,Bold=1,Outline=2,Shadow=0,Alignment=2,MarginV=70'[v];[0:a][1:a]amix=inputs=2:duration=first:weights=1 0.35[a]" -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart reel.mp4
   No audio stream in the input → use `-map 1:a -shortest` instead of amix. No captions → drop the subtitles filter.
6. Verify: ffprobe reel.mp4 → 1080x1920, duration > 0, size ≤ 24 MB (else -crf 28 or trim with -t 60).
7. reel.mp4 at the TOP LEVEL of the workspace → it reaches the user as a video card. Answer in one or two lines.
