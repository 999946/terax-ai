export type DcpPlugin = { id:string; name:string; content:string; schemaVersion:number; enabled:boolean };
export type DcpSnapshot = { plugins:DcpPlugin[]; enabledCount:number; totalCount:number };
export type DcpEvent = { pluginId:string; ok:boolean; error?:string|null };
