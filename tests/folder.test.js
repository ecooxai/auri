import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mergePolledFolderEntries, sortFolderEntries } from "../src/model/folder.js";

const entries = [
  { name: "zeta.txt", kind: "text", size: 2, modified: 100 },
  { name: "alpha.png", kind: "image", size: 3, modified: 300 },
  { name: "Beta.md", kind: "text", size: 1, modified: 200 },
  { name: "Folder", kind: "directory", size: 0, modified: 50 }
];

test("folder entries sort by name, newest date, or type without mutating source", () => {
  assert.deepEqual(sortFolderEntries(entries, "name").map((item) => item.name), ["Folder", "alpha.png", "Beta.md", "zeta.txt"]);
  assert.deepEqual(sortFolderEntries(entries, "date").map((item) => item.name), ["Folder", "alpha.png", "Beta.md", "zeta.txt"]);
  assert.deepEqual(sortFolderEntries(entries, "type").map((item) => item.name), ["Folder", "alpha.png", "Beta.md", "zeta.txt"]);
  assert.deepEqual(entries.map((item) => item.name), ["zeta.txt", "alpha.png", "Beta.md", "Folder"]);
});

test("hidden entries sort after normal entries within folders and files", () => {
  const sorted = sortFolderEntries([
    { name: ".git", kind: "directory" },
    { name: "src", kind: "directory" },
    { name: ".env", kind: "text" },
    { name: "README.md", kind: "text" },
    { name: "assets", kind: "directory" }
  ], "name");

  assert.deepEqual(sorted.map((item) => item.name), ["assets", "src", ".git", "README.md", ".env"]);
});

test("folder polling promotes newly discovered entries while refreshing existing metadata", () => {
  const previous = [{ path: "/tmp/a", name: "a", size: 1 }, { path: "/tmp/b", name: "b", size: 2 }];
  const fresh = [{ path: "/tmp/a", name: "a", size: 9 }, { path: "/tmp/c", name: "c", size: 3 }];
  assert.deepEqual(mergePolledFolderEntries(previous, fresh).map((entry) => [entry.name, entry.size]), [["c", 3], ["a", 9]]);
});

test("native folder bridge exposes creation, metadata, modification dates, and registered commands", async () => {
  const backend = await readFile("src/services/backend.js", "utf8");
  const files = await readFile("src-tauri/src/core/files.rs", "utf8");
  const lib = await readFile("src-tauri/src/lib.rs", "utf8");

  assert.match(backend, /async createFile\(directory, name\)/);
  assert.match(backend, /async createFolder\(directory, name\)/);
  assert.match(backend, /async folderInfo\(path\)/);
  assert.match(backend, /async convertMediaFile/);
  assert.match(files, /pub modified: Option<u64>/);
  assert.match(files, /pub sample_rate: Option<u64>/);
  assert.match(files, /pub fn create_file/);
  assert.match(files, /pub fn create_folder/);
  assert.match(files, /pub fn folder_info/);
  assert.match(files, /pub fn convert_media_file/);
  assert.match(lib, /create_file,/);
  assert.match(lib, /create_folder,/);
  assert.match(lib, /folder_info,/);
  assert.match(lib, /convert_media_file,/);
});

test("native file inspection accepts directories so folder preview clicks can select their row", async () => {
  const files = await readFile("src-tauri/src/core/files.rs", "utf8");

  assert.match(files, /if metadata\.is_dir\(\) \{[\s\S]*kind: "directory"\.to_string\(\)[\s\S]*file_type: "FOLDER"\.to_string\(\)[\s\S]*return Ok\(info\)/);
});


test("audio-to-video ffmpeg uses the shared four-megabit default and explicitly binds showwaves to the source audio", async () => {
  const [files, util] = await Promise.all([
    readFile("src-tauri/src/core/files.rs", "utf8"),
    readFile("src-tauri/src/core/util.rs", "utf8")
  ]);

  assert.match(files, /video_bitrate = normalized_video_bitrate\(bitrate_kbps\)\.to_string\(\)/);
  assert.match(util, /bitrate_kbps\.unwrap_or\(4_000\)\.clamp\(250, 20_000\)/);
  assert.match(files, /\[0:a\]showwaves=s=\{\}:mode=cline:colors=white,format=yuv420p\[v\]/);
  assert.match(files, /command\.args\(\["-map", "\[v\]", "-map", "0:a:0"\]\)/);
  assert.match(files, /command\.args\(\["-c:v", codec, "-b:v", &format!\("\{video_bitrate\}k"\)\]\)/);
});


test("mp4 conversion resolution supports full hd and 2k output", async () => {
  const files = await readFile("src-tauri/src/core/files.rs", "utf8");

  assert.match(files, /"1080" \| "1080p" => Some\("1080"\)/);
  assert.match(files, /"1440" \| "2k" \| "2K" => Some\("1440"\)/);
  assert.match(files, /Some\("1080"\) => "1920x1080"/);
  assert.match(files, /Some\("1440"\) => "2560x1440"/);
});
