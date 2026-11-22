// Run after `npm run build`. Validate the complete manager report workbook,
// including cash reversals and user-supplied formula-looking text.
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {managerFullReportXlsx} from '../dist/mobile/monthly-statement-xlsx.js';
const bill={id:'bill-a',type:'rent',room:'B2',roomId:'room',resident:'=HYPERLINK("evil")',phone:'01799999999',
  residentId:'resident',month:'2026-11-01',dueDate:'2026-11-05',amountMinor:'100000',paidMinor:'30000',
  remainingMinor:'70000',status:'Partial',segments:[],payments:[],houseName:'House & Co',houseId:'house-id'};
const report={month:'2026-11',generatedAt:'2026-11-22T00:00:00Z',scope:'all',expenseTrackingAvailable:false,
  houses:[{houseId:'house-id',name:'House & Co',rooms:2,occupied:1,vacant:1,rentBilledMinor:'100000',
    electricityBilledMinor:'0',rentPaidMinor:'30000',electricityPaidMinor:'0',rentDueMinor:'70000',electricityDueMinor:'0'}],
  total:{rooms:2,occupied:1,vacant:1,billedMinor:'100000',rentBilledMinor:'100000',electricityBilledMinor:'0',
    paidAgainstMonthMinor:'30000',remainingForMonthMinor:'70000',cashReceivedMinor:'-5000',
    rentReceivedMinor:'-5000',electricityReceivedMinor:'0',outstandingThroughMonthMinor:'70000',
    priorOutstandingMinor:'0',outstandingBillCount:1},
  bills:[bill],dues:[bill],receipts:[{receipt:'HL-42',date:'2026-11-22',houseName:'House & Co',room:'B2',
    resident:'Resident',billMonth:'2026-11-01',billType:'rent',method:'Cash',kind:'REVERSAL',
    amountMinor:'-5000',collectedBy:'Manager'}],methods:[{method:'Cash',receivedMinor:'-5000'}],
  trend:[{month:'2026-11',billedMinor:'100000',receivedMinor:'-5000'}]};
const bytes=managerFullReportXlsx(report);
assert.equal(bytes.readUInt32LE(0),0x04034b50);
const entries=new Map();let i=0;
while(i+30<=bytes.length && bytes.readUInt32LE(i)===0x04034b50){
  const size=bytes.readUInt32LE(i+18),nameLen=bytes.readUInt16LE(i+26),extra=bytes.readUInt16LE(i+28);
  const name=bytes.subarray(i+30,i+30+nameLen).toString('utf8');const position=i+30+nameLen+extra;
  entries.set(name,inflateRawSync(bytes.subarray(position,position+size)).toString('utf8'));
  i=position+size;
}
assert.equal(entries.size,14); // 5 metadata + 9 worksheets
assert.match(entries.get('xl/workbook.xml'),/Outstanding Dues/);
assert.match(entries.get('xl/workbook.xml'),/Electricity Meters/);
assert.match(entries.get('xl/worksheets/sheet3.xml'),/HYPERLINK/);
assert.doesNotMatch(entries.get('xl/worksheets/sheet3.xml'),/<f>/);
assert.match(entries.get('xl/worksheets/sheet5.xml'),/HL-42/);
assert.match(entries.get('xl/worksheets/sheet1.xml'),/Net profit/);
console.log('Full manager report: 9 sheets, values and formula-safe cells PASS');
