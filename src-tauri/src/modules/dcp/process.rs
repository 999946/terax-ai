use super::{entry_path,DcpEvent,DcpPlugin,DcpResponse};use serde_json::json;use std::{fs,io::{BufRead,BufReader,Write},process::{Command,Stdio}};
pub fn minimal_script() -> &'static str {
    r#"#!/usr/bin/env node
const readline = require('node:readline');

function snapshot(spaces) {
  const result = {};
  for (const space of Array.isArray(spaces) ? spaces : []) {
    if (!space || typeof space.id !== 'string') continue;
    result[space.id] = {
      summary: typeof space.name === 'string' ? space.name : '',
      status: 'unknown',
      onlineAt: null,
      lastTestedAt: null,
    };
  }
  return result;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method !== 'get_snapshot') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code: -32601, message: 'Method not found' },
    }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id ?? null,
    result: { spaces: snapshot(request.params?.spaces) },
  }) + '\n');
});
"#
}
pub fn write_entry(p:&DcpPlugin)->Result<(),String>{let x=entry_path(&p.id);fs::create_dir_all(x.parent().unwrap()).map_err(|e|e.to_string())?;fs::write(x,&p.content).map_err(|e|e.to_string())}
pub fn request(p:&DcpPlugin,method:&str,params:serde_json::Value)->Result<DcpResponse,String>{write_entry(p)?;let mut c=Command::new("node");c.arg(entry_path(&p.id)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());let mut ch=c.spawn().map_err(|e|e.to_string())?;let mut i=ch.stdin.take().ok_or("stdin")?;let o=ch.stdout.take().ok_or("stdout")?;writeln!(i,"{}",json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})).map_err(|e|e.to_string())?;drop(i);let mut l=String::new();BufReader::new(o).read_line(&mut l).map_err(|e|e.to_string())?;let _=ch.kill();serde_json::from_str(&l).map_err(|e|e.to_string())}
pub fn refresh(p:&DcpPlugin)->Result<DcpEvent,String>{match request(p,"get_snapshot",json!({})){Ok(_)=>Ok(DcpEvent{plugin_id:p.id.clone(),ok:true,error:None}),Err(e)=>Ok(DcpEvent{plugin_id:p.id.clone(),ok:false,error:Some(e)})}}
pub struct DcpRuntime{pub plugins:Vec<DcpPlugin>}impl DcpRuntime{pub fn new(p:Vec<DcpPlugin>)->Self{Self{plugins:p}}}
