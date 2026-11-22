/** Dependency-free OOXML writer. Only internally constructed arithmetic uses formula cells;
 *  all database/user-provided text remains inline strings, never executable Excel formulas.
 */
import { deflateRawSync } from 'node:zlib';
import type { MonthlyStatement, StatementLine } from './mobile-statements.service.js';
import type { ManagerReport, ManagerReportBill, RoomDirectoryEntry } from './mobile-manager-report.service.js';

type FormulaCell={formula:string;result:number};
type Cell = string|number|FormulaCell;
type Sheet = {name:string; rows:Cell[][]; layout?:'room'};
export type ExportManager={name:string;phone:string};
const xml = (s:unknown) => String(s??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const money = (minor:string):number => Number(minor)/100;
const column = (n:number):string => n<26?String.fromCharCode(65+n):column(Math.floor(n/26)-1)+String.fromCharCode(65+n%26);
const cellXml = (value:Cell, row:number,col:number,header:boolean) => {
  const ref=`${column(col)}${row}`;
  if (typeof value==='object') return `<c r="${ref}" s="2"><f>${xml(value.formula)}</f><v>${value.result}</v></c>`;
  if(typeof value==='number' && Number.isFinite(value)) return `<c r="${ref}" s="${header?1:2}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr" s="${header?1:0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
};
const ROOM_HEADERS:Cell[]=['Id','Name of the room user/rent','Mobile number','Room no','Meter no',
  'Running month rent','Electricity unit','Electricity bill','Total bill','Paid','Remaining'];

/** Room report top bar, controlled calculations and print-friendly formatting. */
function roomSheetXml(sheet:Sheet):string {
  const last=sheet.rows.length;
  const totalRow=Math.max(7,last-2); // two explanatory notes follow the total
  const lastDataRow=totalRow-1;
  const columnWidths=[9,31,21,14,24,21,19,21,20,19,20];
  const cols=`<cols>${columnWidths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  function entry(value:Cell,r:number,c:number):string {
    const ref=`${column(c)}${r}`;
    const style=r===1?3:r>=2&&r<=4?(c===0||c===1||c===6||c===7?4:5):
      r===6?6:r===totalRow?(c===4?9:c>=5?(c===6?8:10):0):
      r>totalRow?11:c===0?12:c===6?8:c>=5?7:0;
    if(typeof value==='object') return `<c r="${ref}" s="${style}"><f>${xml(value.formula)}</f><v>${value.result}</v></c>`;
    if(typeof value==='number') return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }
  const rows=sheet.rows.map((vals,i)=>`<row r="${i+1}"${i===1||i===2||i===3?' ht="27" customHeight="1"':i===0?' ht="35" customHeight="1"':i===5?' ht="40" customHeight="1"':''}>${vals.map((v,j)=>v===''?'':entry(v,i+1,j)).join('')}</row>`).join('');
  const merges=['A1:K1',...([2,3,4].flatMap(r=>[`A${r}:B${r}`,`C${r}:F${r}`,`G${r}:H${r}`,`I${r}:K${r}`])),`A${totalRow+1}:K${totalRow+1}`,`A${totalRow+2}:K${totalRow+2}`];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`+
    `<dimension ref="A1:K${last}"/>`+
    `<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A7" sqref="A7"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="16"/>`+
    `${cols}<sheetData>${rows}</sheetData>`+
    (lastDataRow>=7?`<autoFilter ref="A6:K${lastDataRow}"/>`:'')+
    `<mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`+
    `<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.55" bottom="0.55" header="0.2" footer="0.2"/>`+
    `<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>`+
    `</worksheet>`;
}
function sheetXml(sheet:Sheet):string {
  if(sheet.layout==='room') return roomSheetXml(sheet);
  const maxCols=sheet.rows.reduce((wid,row)=>Math.max(wid,row.length),1);
  const header=`<cols>${Array.from({length:maxCols},(_,i)=>`<col min="${i+1}" max="${i+1}" width="${i===0?27:19}" customWidth="1"/>`).join('')}</cols>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`+
    `<dimension ref="A1:${column(maxCols-1)}${Math.max(sheet.rows.length,1)}"/>`+
    `<sheetViews><sheetView workbookViewId="0">${sheet.name==='Summary'?'':'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${header}`+
    `<sheetData>${sheet.rows.map((cells,i)=>`<row r="${i+1}">${cells.map((v,j)=>v===''?'':cellXml(v,i+1,j,i===0 || (sheet.name==='Summary' && i===5))).join('')}</row>`).join('')}</sheetData>`+
    (sheet.name==='Summary' || sheet.rows.length<2?'':`<autoFilter ref="A1:${column(maxCols-1)}${sheet.rows.length}"/>`)+
    `</worksheet>`;
}
const stylesXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`+
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red](#,##0.00);&quot;-&quot;"/>`+
  `<numFmt numFmtId="165" formatCode="#,##0.###;[Red](#,##0.###);&quot;-&quot;"/></numFmts>`+
  `<fonts count="5"><font><sz val="11"/><name val="Aptos"/></font>`+
  `<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font>`+
  `<font><b/><color rgb="FFFFFFFF"/><sz val="16"/><name val="Aptos Display"/></font>`+
  `<font><b/><color rgb="FF115E67"/><sz val="11"/><name val="Aptos"/></font>`+
  `<font><color rgb="FF637483"/><sz val="10"/><name val="Aptos"/></font></fonts>`+
  `<fills count="6"><fill><patternFill patternType="none"/></fill>`+
  `<fill><patternFill patternType="gray125"/></fill>`+
  `<fill><patternFill patternType="solid"><fgColor rgb="FF007C89"/><bgColor indexed="64"/></patternFill></fill>`+
  `<fill><patternFill patternType="solid"><fgColor rgb="FF123E4D"/><bgColor indexed="64"/></patternFill></fill>`+
  `<fill><patternFill patternType="solid"><fgColor rgb="FFF0F8F8"/><bgColor indexed="64"/></patternFill></fill>`+
  `<fill><patternFill patternType="solid"><fgColor rgb="FFDCEEEE"/><bgColor indexed="64"/></patternFill></fill></fills>`+
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>`+
  `<border><left/><right/><top/><bottom style="thin"><color rgb="FFE1E8EB"/></bottom><diagonal/></border></borders>`+
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`+
  `<cellXfs count="13">`+
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`+
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`+
  `<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`+
  `<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`+
  `<xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>`+
  `<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"><alignment vertical="center" wrapText="1"/></xf>`+
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf>`+
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right"/></xf>`+
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right"/></xf>`+
  `<xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1"/>`+
  `<xf numFmtId="164" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>`+
  `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>`+
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment horizontal="center"/></xf>`+
  `</cellXfs>`+
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
    lh.writeUInt16LE(0x0800,6);lh.writeUInt16LE(8,8);lh.writeUInt16LE(0x0021,12);
    lh.writeUInt32LE(crc,14);lh.writeUInt32LE(compressed.length,18);lh.writeUInt32LE(original.length,22);lh.writeUInt16LE(name.length,26);
    local.push(lh,name,compressed);
    const ch=Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);
    ch.writeUInt16LE(0x0800,8);ch.writeUInt16LE(8,10);ch.writeUInt16LE(0x0021,14);ch.writeUInt32LE(crc,16);
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
  const workbook=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView windowWidth="18000" windowHeight="9000"/></bookViews><sheets>${sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const relationships=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const coreProps=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`+
    `<dc:creator>HouseLedger</dc:creator><dc:title>Monthly house report</dc:title></cp:coreProperties>`;
  const appProps=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">`+
    `<Application>HouseLedger</Application></Properties>`;
  const types=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  return zip([
    {name:'[Content_Types].xml',data:types},{name:'_rels/.rels',data:rootRels},
    {name:'xl/workbook.xml',data:workbook},{name:'xl/_rels/workbook.xml.rels',data:relationships},
    {name:'xl/styles.xml',data:stylesXml},
    {name:'docProps/core.xml',data:coreProps},
    {name:'docProps/app.xml',data:appProps},
    ...sheets.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:sheetXml(s)})),
  ]);
}
const makeRow = (bill:StatementLine):Cell[] => [bill.room,bill.resident,bill.phone??'',bill.id,bill.dueDate,
  money(bill.amountMinor),money(bill.paidMinor),money(bill.remainingMinor),bill.status];
type HouseRoom={houseId:string;name:string;address:string};
function decimalMinor(minor:bigint):number {return Number(minor)/100;}
function usableName(s:string):string {return s.replace(/[\\\/\?\*\[\]:]/g,' ').trim().replace(/\s+/g,' ');}
function monthlyRoomSheet(house:HouseRoom,month:string,bills:StatementLine[],directory:RoomDirectoryEntry[],manager:ExportManager,name:string):Sheet {
  type RoomGroup={room:string;roomId:string;resident:string|null;phone:string|null;meter:string|null;bills:StatementLine[]};
  const groups=new Map<string,RoomGroup>();
  for(const room of directory.filter(r=>r.houseId===house.houseId)) groups.set(room.roomId,{...room,bills:[]});
  for(const bill of bills){
    if(!groups.has(bill.roomId)) groups.set(bill.roomId,{room:bill.room,roomId:bill.roomId,resident:bill.resident,
      phone:bill.phone,meter:null,bills:[]});
    groups.get(bill.roomId)!.bills.push(bill);
  }
  const sorted=[...groups.values()].sort((a,b)=>a.room.localeCompare(b.room,undefined,{numeric:true}));
  const dataRows:Cell[][]=sorted.map((room,i)=>{
    const rent=room.bills.filter(b=>b.type==='rent'),elec=room.bills.filter(b=>b.type==='electricity');
    const amount=(items:StatementLine[],key:'amountMinor'|'paidMinor')=>
      items.reduce((sum,b)=>sum+BigInt(b[key]),0n);
    const rentAmount=amount(rent,'amountMinor'), elecAmount=amount(elec,'amountMinor');
    const paid=amount(room.bills,'paidMinor');
    const unit=elec.reduce((sum,b)=>sum+b.segments.reduce((v,m)=>v+Number(m.usage??0),0),0);
    const meterNumbers=[...new Set(elec.flatMap(b=>b.segments.map(seg=>seg.meter).filter((m):m is string=>Boolean(m))))];
    if(!meterNumbers.length && room.meter) meterNumbers.push(room.meter);
    const residents=[...new Set(room.bills.map(b=>b.resident).filter(Boolean))];
    const phones=[...new Set(room.bills.map(b=>b.phone).filter((p):p is string=>Boolean(p)))];
    const row=i+7;
    return [i+1,residents.join(', ')||room.resident||'Vacant',phones.join(', ')||room.phone||'',
      room.room,meterNumbers.join(', '),decimalMinor(rentAmount),unit,decimalMinor(elecAmount),
      {formula:`F${row}+H${row}`,result:decimalMinor(rentAmount+elecAmount)},decimalMinor(paid),
      {formula:`I${row}-J${row}`,result:decimalMinor(rentAmount+elecAmount-paid)}];
  });
  const totalIndex=dataRows.length+7;
  const first=7,last=totalIndex-1;
  const totalCell=(col:string):FormulaCell=>({formula:dataRows.length?`SUM(${col}${first}:${col}${last})`:'0',
    result:dataRows.reduce((sum,r)=>{
      const index=col.charCodeAt(0)-65;
      const value=r[index];return sum+(typeof value==='number'?value:typeof value==='object'?value.result:0);
    },0)});
  const pad=(values:Cell[]):Cell[]=>[...values,...Array(Math.max(0,11-values.length)).fill('')];
  const rows:Cell[][]=[
    pad(['HOUSELEDGER | MONTHLY RENT & ELECTRICITY REPORT']),
    pad(['House name','',house.name,'','','','Manager name','',manager.name]),
    pad(['Address','',house.address,'','','','Mobile number','',manager.phone]),
    pad(['Billing month','',month,'','','','Currency','', 'BDT (Tk)']),
    pad([]),ROOM_HEADERS,
    ...dataRows,
    ['', '', '', '', 'TOTAL',totalCell('F'),totalCell('G'),totalCell('H'),totalCell('I'),totalCell('J'),totalCell('K')],
    pad(['Amounts reflect ISSUED bills only; "-" means zero or no issued bill.']),
    pad(['Paid and remaining amounts reflect payments recorded at export time, including later payments.']),
  ];
  return {name,rows,layout:'room'};
}

export function monthlyStatementXlsx(data:MonthlyStatement, directory:RoomDirectoryEntry[]=[], manager:ExportManager={name:'',phone:''}):Buffer {
  const rent=data.bills.filter(b=>b.type==='rent');
  const electricity=data.bills.filter(b=>b.type==='electricity');
  const sheets:Sheet[]=[
    monthlyRoomSheet({houseId:data.house.id,name:data.house.name,address:data.house.address??''},data.month,data.bills,directory,manager,'Monthly Report'),
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
export function managerFullReportXlsx(data:ManagerReport, directory:RoomDirectoryEntry[]=[], manager:ExportManager={name:'',phone:''}):Buffer {
  const rent=data.bills.filter(b=>b.type==='rent');
  const electricity=data.bills.filter(b=>b.type==='electricity');
  const total=data.total;
  const sheets:Sheet[]=[
    ...data.houses.map((h,i)=>monthlyRoomSheet({houseId:h.houseId,name:h.name,address:h.address??''},data.month,
      data.bills.filter(b=>b.houseId===h.houseId),directory,manager,
      data.houses.length===1?'Monthly Report':`${i+1} ${usableName(h.name)}`.slice(0,31))),
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
