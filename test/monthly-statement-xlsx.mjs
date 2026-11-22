// Run after npm run build. Verify ZIP/OOXML without extra dependencies.
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { monthlyStatementXlsx } from '../dist/mobile/monthly-statement-xlsx.js';
const summary=(count,amount,paid)=>({count,billedMinor:String(amount),collectedMinor:String(paid),remainingMinor:String(amount-paid)});
const data={month:'2026-11',house:{id:'id',name:'Test & <home>'},summary:{rent:summary(1,220000,100000),electricity:summary(1,50000,50000)},bills:[
  {id:'bill-1',type:'rent',room:'201',resident:'=1+1',phone:'01700000000',dueDate:'2026-11-05',amountMinor:'220000',paidMinor:'100000',remainingMinor:'120000',status:'Partial',segments:[],payments:[{id:'payment-1',receipt:'HL-123',kind:'PAYMENT',method:'Cash',date:'2026-11-12',amountMinor:'100000',collectedBy:'Manager'}]},
  {id:'bill-2',type:'electricity',room:'201',resident:'Resident',phone:'01700000000',dueDate:'2026-11-10',amountMinor:'50000',paidMinor:'50000',remainingMinor:'0',status:'Paid',segments:[{meter:'ABC',previous:'100',current:'110',usage:'10',rate:'50'}],payments:[]},
]};
const buffer=monthlyStatementXlsx(data);
assert.equal(buffer.readUInt32LE(0),0x04034b50);
const entries=new Map();
let i=0;
while(buffer.readUInt32LE(i)===0x04034b50){
  const size=buffer.readUInt32LE(i+18),nameLen=buffer.readUInt16LE(i+26),extraLen=buffer.readUInt16LE(i+28);
  const name=buffer.subarray(i+30,i+30+nameLen).toString('utf8');
  const dataAt=i+30+nameLen+extraLen;
  entries.set(name,inflateRawSync(buffer.subarray(dataAt,dataAt+size)).toString('utf8'));
  i=dataAt+size;
}
assert.equal(entries.size,10);
assert.match(entries.get('xl/workbook.xml'),/Electricity Bills/);
assert.match(entries.get('xl/worksheets/sheet2.xml'),/t="inlineStr"[^>]*><is><t xml:space="preserve">=1\+1/);
assert.doesNotMatch(entries.get('xl/worksheets/sheet2.xml'),/<f>/);
assert.match(entries.get('xl/worksheets/sheet5.xml'),/HL-123/);
assert.match(entries.get('xl/worksheets/sheet4.xml'),/>110</);
console.log('Monthly statement XLSX/ZIP and formula-safe cells: PASS');
