import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function loadImages(imagePaths = []) {
  if (!Array.isArray(imagePaths) || imagePaths.length > 5) throw new Error("Provide at most 5 imagePaths");
  let total = 0;
  const images = [];
  for (const imagePath of imagePaths) {
    if (typeof imagePath !== "string" || !path.isAbsolute(imagePath)) throw new Error("Image paths must be absolute");
    const info = await fs.stat(imagePath);
    if (!info.isFile() || !info.size || info.size > 8 * 1024 * 1024) throw new Error("Images must be non-empty files of at most 8 MiB");
    total += info.size;
    if (total > 24 * 1024 * 1024) throw new Error("Total image size must not exceed 24 MiB");
    const bytes = await fs.readFile(imagePath);
    let mime;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png";
    else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = "image/jpeg";
    else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") mime = "image/webp";
    else if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) mime = "image/gif";
    else throw new Error("Only PNG, JPEG, WebP and GIF image files are supported");
    images.push({ name: path.basename(imagePath), mime, size: bytes.length, base64: bytes.toString("base64") });
  }
  return images;
}

export async function probeVideo(videoPath) {
  const { stdout } = await execute(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", videoPath
  ], { windowsHide: true, timeout: 30000 });
  const info = JSON.parse(stdout);
  const stream = info.streams?.find((item) => item.codec_type === "video");
  const duration = Number(info.format?.duration);
  if (!stream || !(duration > 0)) throw new Error("Downloaded file is not a playable video");
  return { duration, width: stream.width, height: stream.height };
}

export async function extractTail(videoPath, targetPath) {
  const info = await probeVideo(videoPath);
  await execute(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-sseof", "-1", "-i", videoPath,
    "-map", "0:v:0", "-an", "-vsync", "0", "-update", "1", "-y", targetPath
  ], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  const output = await fs.stat(targetPath);
  if (!output.size) throw new Error("Tail frame extraction produced no image");
  return { path: targetPath, ...info };
}
