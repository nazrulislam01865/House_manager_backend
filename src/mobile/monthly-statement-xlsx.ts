/** Minimal OOXML Spreadsheet writer: dependency-free, valid .xlsx, no formula evaluation.
 *  All untrusted values are written as inline strings (never formula cells).
 */
import { deflateRawSync } from 'node:zlib';
import type { MonthlyStatement, StatementLine } from './mobile-statements.service.js';
import type { ManagerReport, ManagerReportBill } from './mobile-manager-report.service.js';

type Cell = string|number;
type Sheet = {name:string; rows:Cell[][]};
const xml = (s:unknown) => String(s??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const money = (minor:string):number => Number(minor)/100;
const column = (n:number):string => n<26?String.fromCharCode(65+n):column(Math.floor(n/26)-1)+String.fromCharCode(65+n%26);
const cellXml = (value:Cell, row:number,col:number,header:boolean) => {
  const ref=`${column(col)}${row}`;
  if(typeof value==='number' && Number.isFinite(value)) return `<c r="${ref}" s="${header?1:2}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr" s="${header?1:0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
};
function sheetXml(sheet:Sheet):string {
  const maxCols=sheet.rows.reduce((wid,row)=>Math.max(wid,row.length),1);
  const header=`<cols>${Array.from({length:maxCols},(_,i)=>`<col min="${i+1}" max="${i+1}" width="${i===0?27:19}" customWidth="1"/>`).join('')}</cols>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`+
    `<dimension ref="A1:${column(maxCols-1)}${Math.max(sheet.rows.length,1)}"/>`+
    `<sheetViews><sheetView workbookViewId="0">${sheet.name==='Summary'?'':'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'}</sheetView></sheetViews>${header}`+
    `<sheetData>${sheet.rows.map((cells,i)=>`<row r="${i+1}">${cells.map((v,j)=>cellXml(v,i+1,j,i===0 || (sheet.name==='Summary' && i===5))).join('')}</row>`).join('')}</sheetData>`+
    (sheet.name==='Summary'?'':`<autoFilter ref="A1:${column(maxCols-1)}${sheet.rows.length}"/>`)+
    `</worksheet>`;
}
const stylesXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`+
  `<fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts>`+
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF007C89"/><bgColor indexed="64"/></patternFill></fill></fills>`+
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`+
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`+
  `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`+
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`+
  `</styleSheet>`;
function crc32(data:Buffer):number {
  let crc=-1;
  for(const byte of data) {
    crc^=byte;
    for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^-1)>>>0;
}
function zip(entries:{name:string;data:string}[]):Buffer {
  const local:Buffer[]=[], central:Buffer[]=[];
  let offset=0;
  for(const entry of entries) {
    const name=Buffer.from(entry.name,'utf8');
    const original=Buffer.from(entry.data,'utf8');
    const compressed=deflateRawSync(original);
    const crc=crc32(original);
    const lh=Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);
    lh.writeUInt16LE(0x0800,6);lh.writeUInt16LE(8,8);
    lh.writeUInt32LE(crc,14);lh.writeUInt32LE(compressed.length,18);lh.writeUInt32LE(original.length,22);lh.writeUInt16LE(name.length,26);
    local.push(lh,name,compressed);
    const ch=Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);
    ch.writeUInt16LE(0x0800,8);ch.writeUInt16LE(8,10);ch.writeUInt32LE(crc,16);
    ch.writeUInt32LE(compressed.length,20);ch.writeUInt32LE(original.length,24);
    ch.writeUInt16LE(name.length,28);ch.writeUInt32LE(offset,42);
    central.push(ch,name);
    offset+=lh.length+name.length+compressed.length;
  }
  const size=central.reduce((n,b)=>n+b.length,0);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}

function packageWorkbook(sheets:Sheet[]):Buffer {
  const workbook=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`;
  const relationships=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const types=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zip([
    {name:'[Content_Types].xml',data:types},{name:'_rels/.rels',data:rootRels},
    {name:'xl/workbook.xml',data:workbook},{name:'xl/_rels/workbook.xml.rels',data:relationships},
    {name:'xl/styles.xml',data:stylesXml},
    ...sheets.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:sheetXml(s)})),
  ]);
}
const makeRow = (bill:StatementLine):Cell[] => [bill.room,bill.resident,bill.phone??'',bill.id,bill.dueDate,
  money(bill.amountMinor),money(bill.paidMinor),money(bill.remainingMinor),bill.status];
export function monthlyStatementXlsx(data:MonthlyStatement):Buffer {
  const rent=data.bills.filter(b=>b.type==='rent');
  const electricity=data.bills.filter(b=>b.type==='electricity');
  const sheets:Sheet[]=[
    {name:'Summary',rows:[['HouseLedger monthly statement','Value'],['House',data.house.name],
      ['Billing month',data.month],['Currency','BDT (Tk)'],[],
      ['Category','Bills','Billed (Tk)','Collected (Tk)','Remaining (Tk)'],
      ...(['rent','electricity'] as const).map(t=>[t==='rent'?'Rent':'Electricity',data.summary[t].count,
        money(data.summary[t].billedMinor),money(data.summary[t].collectedMinor),money(data.summary[t].remainingMinor)] as Cell[]),
      ['Total',data.summary.rent.count+data.summary.electricity.count,
        money((BigInt(data.summary.rent.billedMinor)+BigInt(data.summary.electricity.billedMinor)).toString()),
        money((BigInt(data.summary.rent.collectedMinor)+BigInt(data.summary.electricity.collectedMinor)).toString()),
        money((BigInt(data.summary.rent.remainingMinor)+BigInt(data.summary.electricity.remainingMinor)).toString())]]},
    {name:'Rent Bills',rows:[['Room','Resident','Mobile','Bill ID','Due date','Billed (Tk)','Collected (Tk)','Remaining (Tk)','Status'],
      ...rent.map(makeRow)]},
    {name:'Electricity Bills',rows:[['Room','Resident','Mobile','Bill ID','Due date','Billed (Tk)','Collected (Tk)','Remaining (Tk)','Status','Meters','Previous reading','Current reading','Usage (kWh)','Rate (Tk/kWh)'],
      ...electricity.map(b=>[...makeRow(b),b.segments.map(s=>s.meter??'').join(', '),
        b.segments.map(s=>s.previous??'').join(', '),b.segments.map(s=>s.current??'').join(', '),
        b.segments.reduce((sum,s)=>sum+Number(s.usage??0),0),
        b.segments.map(s=>s.rate??'').join(', ')] as Cell[])]},
    {name:'Meter Details',rows:[['Bill ID','Room','Resident','Meter','Previous reading','Current reading','Usage (kWh)','Rate (Tk/kWh)'],
      ...electricity.flatMap(b=>b.segments.map(s=>[b.id,b.room,b.resident,s.meter??'',s.previous==null?'':Number(s.previous),s.current==null?'':Number(s.current),
        s.usage==null?'':Number(s.usage),s.rate==null?'':Number(s.rate)] as Cell[]))]},
    {name:'Receipts',rows:[['Bill ID','Bill type','Room','Resident','Receipt','Date','Payment type','Method','Amount (Tk)','Collected by'],
      ...data.bills.flatMap(b=>b.payments.map(p=>[b.id,b.type,b.room,b.resident,p.receipt,p.date,p.kind,p.method,
        money(p.amountMinor)*(p.kind==='REVERSAL'?-1:1),p.collectedBy] as Cell[]))]},
  ];
  return packageWorkbook(sheets);
}

const fullBillRow = (b:ManagerReportBill):Cell[] => [b.houseName,b.room,b.resident,b.phone??'',b.id,
  b.month,b.dueDate,money(b.amountMinor),money(b.paidMinor),money(b.remainingMinor),b.status];
/** Complete manager report. Current balances are not retroactive cash-position snapshots. */
export function managerFullReportXlsx(data:ManagerReport):Buffer {
  const rent=data.bills.filter(b=>b.type==='rent');
  const electricity=data.bills.filter(b=>b.type==='electricity');
  const total=data.total;
  const sheets:Sheet[]=[
    {name:'Overview',rows:[
      ['HouseLedger manager report','Value'],
      ['Month',data.month],['Properties',data.scope==='all'?'All assigned properties':data.houses.map(h=>h.name).join(', ')],
      ['Generated at (UTC)',data.generatedAt],['Currency','BDT (Tk)'],[],
      ['Reporting metric','Amount / count'],
      ['Monthly rent billed (Tk)',money(total.rentBilledMinor)],
      ['Monthly electricity billed (Tk)',money(total.electricityBilledMinor)],
      ['Total monthly billed (Tk)',money(total.billedMinor)],
      ['Paid towards selected-month bills (Tk)',money(total.paidAgainstMonthMinor)],
      ['Remaining on selected-month bills (Tk)',money(total.remainingForMonthMinor)],[],
      ['Payments received during month (Tk)',money(total.cashReceivedMinor)],
      ['Rent receipts during month (Tk)',money(total.rentReceivedMinor)],
      ['Electricity receipts during month (Tk)',money(total.electricityReceivedMinor)],[],
      ['Currently outstanding (bills through month) (Tk)',money(total.outstandingThroughMonthMinor)],
      ['Earlier-month bills still unpaid (Tk)',money(total.priorOutstandingMinor)],
      ['Outstanding bill count',total.outstandingBillCount],[],
      ['Total rooms',total.rooms],['Currently occupied rooms',total.occupied],
      ['Currently vacant rooms',total.vacant],[],
      ['Operating expenses','Not recorded in the current backend'],
      ['Net profit','Unavailable without expense records'],
      ['Reporting note','Paid amounts and unpaid balances reflect the ledger at report generation time, not historical month-end positions'],
      ['Collection note','Receipts are grouped by payment received date, even for bills from other months'],
    ]},
    {name:'Property Summary',rows:[
      ['House','Rooms','Occupied now','Vacant now','Rent billed (Tk)','Electricity billed (Tk)',
        'Rent collected against month (Tk)','Electricity collected against month (Tk)',
        'Rent due (Tk)','Electricity due (Tk)'],
      ...data.houses.map(h=>[h.name,h.rooms,h.occupied,h.vacant,money(h.rentBilledMinor),money(h.electricityBilledMinor),
        money(h.rentPaidMinor),money(h.electricityPaidMinor),money(h.rentDueMinor),money(h.electricityDueMinor)] as Cell[]),
    ]},
    {name:'Rent Bills',rows:[
      ['House','Room','Resident','Phone','Bill ID','Bill month','Due date','Billed (Tk)','Paid (Tk)','Due (Tk)','Status'],
      ...rent.map(fullBillRow),
    ]},
    {name:'Electricity Bills',rows:[
      ['House','Room','Resident','Phone','Bill ID','Bill month','Due date','Billed (Tk)','Paid (Tk)','Due (Tk)','Status'],
      ...electricity.map(fullBillRow),
    ]},
    {name:'Month Receipts',rows:[
      ['Receipt','Date received','House','Room','Resident','Bill month','Bill type','Method','Transaction kind','Signed amount (Tk)','Collected by'],
      ...data.receipts.map(r=>[r.receipt,r.date,r.houseName,r.room,r.resident,r.billMonth,
        r.billType,r.method,r.kind,money(r.amountMinor),r.collectedBy] as Cell[]),
    ]},
    {name:'Outstanding Dues',rows:[
      ['House','Room','Resident','Phone','Bill ID','Bill month','Due date','Billed (Tk)','Paid (Tk)','Due (Tk)','Status'],
      ...data.dues.map(fullBillRow),
    ]},
    {name:'Monthly Trend',rows:[
      ['Month','Bills issued (Tk)','Cash received in month (Tk)'],
      ...data.trend.map(t=>[t.month,money(t.billedMinor),money(t.receivedMinor)] as Cell[]),
    ]},
    {name:'Payment Methods',rows:[
      ['Method','Net received this month (Tk)'],
      ...data.methods.map(m=>[m.method,money(m.receivedMinor)] as Cell[]),
    ]},
    {name:'Electricity Meters',rows:[
      ['House','Room','Resident','Bill ID','Meter','Previous reading','Current reading','Usage (kWh)','Rate (Tk/kWh)'],
      ...electricity.flatMap(b=>b.segments.map(m=>[b.houseName,b.room,b.resident,b.id,m.meter??'',
        m.previous==null?'':Number(m.previous),m.current==null?'':Number(m.current),
        m.usage==null?'':Number(m.usage),m.rate==null?'':Number(m.rate)] as Cell[])),
    ]},
  ];
  return packageWorkbook(sheets);
}
