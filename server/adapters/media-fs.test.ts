import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Media } from "../media.ts";
import { createDir } from "../fsbrowse.ts";
import { extractImages, diffStats } from "../artifacts.ts";
import { mapPiMessage } from "./pi.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test("signed local images preserve native/markdown assets and enforce signature, roots and image bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-media-"));
  try {
    writeFileSync(join(root,"image.png"),Buffer.from(PNG,"base64"));
    writeFileSync(join(root,"fake.png"),"not an image");
    symlinkSync("/etc",join(root,"outside"));
    const media = new Media("test-secret",[root]);
    const item = media.item({id:"x",kind:"assistant",text:"![result](image.png)",images:[{src:join(root,"image.png")}]},root);
    const url = new URL(item.images![0].src,"http://local");
    assert.ok(item.text.includes("/api/media?"));
    const read=await media.read(url.searchParams.get("p")!,url.searchParams.get("s")!);
    assert.equal(read.mime,"image/png");assert.equal(read.bytes.length,Buffer.from(PNG,"base64").length);
    await assert.rejects(()=>media.read(url.searchParams.get("p")!,"x"),{status:403});
    assert.equal(media.source("/etc/passwd"),null);
    assert.equal(media.source(join(root,"outside/fake.png")),null);
    const bad=new URL(media.source(join(root,"fake.png"))!,"http://local");
    await assert.rejects(()=>media.read(bad.searchParams.get("p")!,bad.searchParams.get("s")!),{status:415});
    assert.equal(media.source("data:text/html;base64,YQ=="),null);
    const missing = media.item({ id: "missing", kind: "tool", text: "", images: [{ src: join(root,"missing.png"), alt: "old result" }] }, root);
    assert.deepEqual(missing.images, [{ src: "", alt: "old result" }]);
    assert.equal(extractImages([{type:"image",source:{type:"base64",media_type:"image/png",data:PNG}}])[0].src,`data:image/png;base64,${PNG}`);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("folder creation rejects traversal, duplicate names and parents outside roots",()=>{
  const root=mkdtempSync(join(tmpdir(),"aw-folder-"));
  try {
    assert.equal(createDir(root,"New project",[root]).path,join(realpathSync(root),"New project"));
    assert.throws(()=>createDir(root,"New project",[root]),{status:409});
    for(const name of ["../outside","a/b","a\\b",".","..",""])assert.throws(()=>createDir(root,name,[root]),{status:400});
    assert.throws(()=>createDir("/etc","outside",[root]),{status:400});
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("PI edit and Bash terminal details survive mapping",()=>{
  const edit=mapPiMessage({id:"edit",role:"tool",toolName:"Edit",toolStatus:"success",toolDurationMs:25,toolResult:{content:[{type:"text",text:"done"}],details:{path:"app.ts",review:{additions:3,deletions:1}}}})[0];
  assert.equal(edit.tool?.status,"ok");assert.equal(edit.tool?.additions,3);assert.equal(edit.tool?.deletions,1);assert.equal(edit.tool?.output,"done");
  const command=mapPiMessage({id:"run",role:"tool",toolName:"Bash",toolStatus:"success",toolResult:{details:{exitCode:0},content:[{type:"text",text:"hello"}]}})[0];
  assert.equal(command.tool?.exitCode,0);
  assert.deepEqual(diffStats("--- a\n+++ b\n@@ -1 +1,3 @@\n-old\n+new\n+two\n+three"),{additions:3,deletions:1});
});
