"""Create a transparent 25 fps bridge between two generated presenter tracks."""
import json
import subprocess
import sys

import cv2
import numpy as np


def main(config):
    ff = config["ffmpeg"]
    width, height = config["width"], config["height"]
    count = config["frames"]
    cv2.setNumThreads(2)

    def args(file, options):
        return [ff, "-nostdin", "-v", "error", *options, "-c:v", "libvpx-vp9", "-i", file, "-an"]

    def read(file, options, filt, n, w, h, gray=False):
        data = subprocess.check_output(args(file, options) + [
            "-vf", filt, "-frames:v", str(n), "-pix_fmt", "gray" if gray else "rgba", "-f", "rawvideo", "-"
        ])
        return np.frombuffer(data, np.uint8).reshape((-1, h, w) if gray else (-1, h, w, 4))

    before = read(config["before"], ["-sseof", "-0.4"], "reverse", 1, width, height)[0]
    after = read(config["after"], [], "null", 1, width, height)[0]
    tw = min(144, width)
    th = max(1, round(height * tw / width))
    # Compare premultiplied appearance; arbitrary RGB under fully transparent pixels must not affect matching.
    def appearance(frame):
        lum = cv2.cvtColor(frame[:, :, :3], cv2.COLOR_RGB2GRAY).astype(np.float32)
        return cv2.resize((lum - 128) * (frame[:, :, 3] / 255) + 128, (tw, th), interpolation=cv2.INTER_AREA)

    candidates = min(125, config["idleFrames"])
    samples = read(config["idle"], ["-stream_loop", "-1"],
                   f"fps=25,scale={tw}:{th}:flags=area,format=rgba", candidates + count + 1, tw, th)
    sample_alpha = samples[:, :, :, 3].astype(np.float32) / 255
    small = np.stack([cv2.cvtColor(s[:, :, :3], cv2.COLOR_RGB2GRAY) for s in samples])
    small = (small.astype(np.float32) - 128) * sample_alpha + 128
    def difference(images, ref):
        delta = images - appearance(ref)
        return np.mean(np.abs(delta), axis=(1, 2)) + 0.5 * np.mean(np.abs(np.diff(delta, axis=2)), axis=(1, 2))
    phase = int(np.argmin(difference(small[:candidates], before) +
                          difference(small[count+1:count+1+candidates], after)))
    # Bound the working area around the presenter, including the whole selected idle segment.
    mask = np.maximum(before[:, :, 3], after[:, :, 3])
    small_mask = samples[phase:phase+count+2, :, :, 3].max(axis=0)
    mask |= cv2.resize(small_mask, (width, height), interpolation=cv2.INTER_NEAREST)
    x, y, w, h = cv2.boundingRect(mask)
    x0, y0 = max(0, x-12), max(0, y-12)
    x1, y1 = min(width, x+w+12), min(height, y+h+12)
    if x1-x0 < 16 or y1-y0 < 16:
        raise ValueError("No visible presenter")
    roi = np.s_[y0:y1, x0:x1]
    h, w = before[roi].shape[:2]
    scale = min(1, 540/max(w,h))
    size = (max(16, round(scale*w)), max(16, round(scale*h)))
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    solver = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)

    def premul(frame):
        frame = frame.astype(np.float32)
        frame[:, :, :3] *= frame[:, :, 3:4] / 255
        return frame

    def gray(frame):
        gray = cv2.cvtColor(frame[:, :, :3], cv2.COLOR_RGB2GRAY) + (255-frame[:, :, 3]) * 0.5
        return cv2.resize(np.uint8(np.clip(gray, 0, 255)), size, interpolation=cv2.INTER_AREA)

    def flow(a, b):
        f = solver.calc(gray(a), gray(b), None)
        f = cv2.resize(f, (w, h))
        f *= [w/size[0], h/size[1]]
        return f

    def warp(image, f, t):
        return cv2.remap(image, xx-t*f[:, :, 0], yy-t*f[:, :, 1], cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_REPLICATE)

    first, last = premul(before[roi]), premul(after[roi])
    # Face detection is only used to keep lips at their actual pause pose when the idle reference is speaking.
    face_detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    mouth = None
    if not face_detector.empty():
        faces = face_detector.detectMultiScale(gray(first), 1.1, 4, minSize=(20, 20))
        if len(faces):
            fx, fy, fw, fh = max(faces, key=lambda r: r[2]*r[3])
            cx, cy = (fx+fw*0.5)*w/size[0], (fy+fh*0.76)*h/size[1]
            mouth = np.exp(-(((xx-cx)/max(4, fw*w/size[0]*0.27))**4 +
                             ((yy-cy)/max(4, fh*h/size[1]*0.16))**4)).astype(np.float32)[:, :, None]
    reader = subprocess.Popen(args(config["idle"], ["-stream_loop", "-1"]) + [
        "-vf", f"fps=25,trim=start_frame={phase+1}", "-frames:v", str(count),
        "-pix_fmt", "rgba", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    encoder = subprocess.Popen([ff, "-v", "error", "-y", "-f", "rawvideo", "-s", f"{width}x{height}",
        "-r", "25", "-pix_fmt", "rgba", "-i", "-", "-c:v", "libvpx-vp9", "-lossless", "1", "-b:v", "0",
        "-threads", "4", "-row-mt", "1", "-deadline", "realtime", "-cpu-used", "6",
        "-pix_fmt", "yuva420p", config["output"]], stdin=subprocess.PIPE)
    try:
        for index in range(1, count+1):
            data = reader.stdout.read(width*height*4)
            if len(data) != width*height*4:
                raise ValueError("Incomplete idle video")
            full = np.frombuffer(data, np.uint8).reshape(height, width, 4).copy()
            pose = premul(full[roi])
            t = index/(count+1)
            anchor = first if t <= 0.5 else last
            into_anchor = flow(pose, anchor)
            if mouth is not None:
                pose = pose*(1-mouth) + warp(anchor, into_anchor, -1)*mouth
            weight = min(1, index/min(8, (count+1)/2), (count+1-index)/min(8, (count+1)/2))
            weight = weight*weight*(3-2*weight)
            if weight < 1:
                pose = cv2.addWeighted(warp(anchor, flow(anchor, pose), weight), 1-weight,
                                       warp(pose, into_anchor, 1-weight), weight, 0)
            pose[:, :, :3] *= 255/np.maximum(1, pose[:, :, 3:4])
            full[roi] = np.uint8(np.clip(np.rint(pose), 0, 255))
            encoder.stdin.write(full.tobytes())
        encoder.stdin.close()
        if reader.wait() or encoder.wait():
            raise RuntimeError("FFmpeg could not finish the transition")
    finally:
        for process in (reader, encoder):
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as file:
        main(json.load(file))
