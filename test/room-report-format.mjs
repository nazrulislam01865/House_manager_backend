import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const previewDir=process.env.HOUSELEDGER_PREVIEW_DIR;
import {monthlyStatementXlsx,managerFullReportXlsx} from '../dist/mobile/monthly-statement-xlsx.js';
const r=(id,room,resident,phone,type,amount,paid,segments=[])=>({id,roomId:room,room,resident,phone,
  type,month:'2026-11-01',dueDate:'2026-11-07',amountMinor:String(amount),paidMinor:String(paid),
  remainingMinor:String(amount-paid),status:paid>=amount?'Paid':'Partial',segments,payments:[],
  houseId:'house-1',houseName:'Moonlight House'});
const bills=[
  r('bill-1','101','Ayesha Rahman','01712345678','rent',1200000,700000),
  r('bill-2','101','Ayesha Rahman','01712345678','electricity',230000,110000,[{meter:'METER 1001',previous:'100',current:'143.5',usage:'43.5',rate:'52.87'}]),
  r('bill-3','102','Farzana','01711111111','rent',900000,900000),
];
const directory=[
  {houseId:'house-1',roomId:'101',room:'101',resident:'Old record',phone:'01712345678',meter:'METER 1001'},
  {houseId:'house-1',roomId:'102',room:'102',resident:'Farzana',phone:'01711111111',meter:'METER 1002'},
  {houseId:'house-1',roomId:'103',room:'103',resident:null,phone:null,meter:'METER 1003'},
];
const house={id:'house-1',name:'Moonlight House',address:'Road 6, Dhaka, Bangladesh'};
const month='2026-11',manager={name:'Demo Manager',phone:'01722222222'};
const summary=(amount,paid,count)=>({count,billedMinor:String(amount),collectedMinor:String(paid),remainingMinor:String(amount-paid)});
const statement={month,house,summary:{rent:summary(2100000,1600000,2),electricity:summary(230000,110000,1)},bills};
const bytes=monthlyStatementXlsx(statement,directory,manager);
if(previewDir)writeFileSync(join(previewDir,'HouseLedger_Monthly_Report_Layout_Preview.xlsx'),bytes);
const base={month,generatedAt:'2026-11-22T00:00:00Z',scope:'house',expenseTrackingAvailable:false,
  houses:[{houseId:'house-1',name:house.name,address:house.address,rooms:3,occupied:2,vacant:1,
    rentBilledMinor:'2100000',electricityBilledMinor:'230000',rentPaidMinor:'1600000',electricityPaidMinor:'110000',
    rentDueMinor:'500000',electricityDueMinor:'120000'}],
  total:{rooms:3,occupied:2,vacant:1,billedMinor:'2330000',rentBilledMinor:'2100000',electricityBilledMinor:'230000',
    paidAgainstMonthMinor:'1710000',remainingForMonthMinor:'620000',cashReceivedMinor:'1710000',
    rentReceivedMinor:'1600000',electricityReceivedMinor:'110000',outstandingThroughMonthMinor:'620000',
    priorOutstandingMinor:'0',outstandingBillCount:2},bills,dues:bills.filter(b=>Number(b.remainingMinor)>0),
  receipts:[],methods:[],trend:[]};
const fullBytes=managerFullReportXlsx(base,directory,manager);
assert(fullBytes.length>bytes.length);
if(previewDir)writeFileSync(join(previewDir,'HouseLedger_Manager_Report_Layout_Preview.xlsx'),fullBytes);
const second={houseId:'house-2',name:'New Wing / North',address:'Second address',rooms:1,occupied:0,vacant:1,
  rentBilledMinor:'0',electricityBilledMinor:'0',rentPaidMinor:'0',electricityPaidMinor:'0',
  rentDueMinor:'0',electricityDueMinor:'0'};
const all=managerFullReportXlsx({...base,scope:'all',houses:[...base.houses,second]},
  [...directory,{houseId:'house-2',roomId:'201',room:'201',resident:null,phone:null,meter:'A-201'}],manager);
assert(all.length>fullBytes.length);
const byteText=all.toString('latin1');
assert(byteText.includes('xl/workbook.xml'));
console.log('Room report XLSX fixture: single-house & all-house exports PASS',bytes.length,fullBytes.length,all.length);
