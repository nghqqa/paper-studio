const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {numberingCommand, parseInput} = require('../native.js');
const copy = value => JSON.parse(JSON.stringify(value));
const mathRun = text => ({type:'mathRun', mathPr:{}, rPr:{rFonts:{ascii:'Cambria Math'}}, content:Array.from(text, c=>({type:'mathTxt',value:c.codePointAt(0)}))});
const source = (math=[mathRun('E=mc^2#(2)')]) => ({type:'paragraph',bFromDocument:true,pPr:{type:'paraPr'},rPr:{type:'textPr'},changes:[],content:[{type:'run',content:[],reviewType:'common'}, {type:'paraMath',oMathParaPr:{},content:math},{type:'endRun',content:[],reviewType:'common'}]});
const parseParagraph = value => numberingCommand({action:'parse-paragraph',value}).input;

function editor(json=source(), options={}) {
  const handlers = {};
  const calls = {actions:0,finalized:0,undo:0,recalc:0,converted:0};
  let doc, Api;
  function paragraph(data=source([])) {
    let value = copy(data);
    const p = {
      GetClassType:()=> 'paragraph', GetStyle:()=> null, GetTextPr:()=> ({GetFontSize:()=>22}),
      SetStyle(){}, SetFontSize(v){this.fontSize=v;}, SetJc(v){this.jc=v;}, SetSpacingBefore(){},SetSpacingAfter(){},
      SetIndLeft(){},SetIndRight(){},SetIndFirstLine(){}, AddText(t){const run={type:'run',content:[t]};value.content.splice(value.content.length-1,0,run);this.text=t;return {GetTextPr:()=>({SetFontSize:v=>{run.fontSize=v;this.numberFontSize=v;}})};},
      GetParaPr(){return {SetTabs:(positions,alignments)=>{this.tabs=Array.from(positions);this.tabAlign=Array.from(alignments);return !options.tabsFail;},GetTabs:()=> (this.tabs || []).map((Pos,i)=>({Pos,Val:this.tabAlign[i]}))};},
      AddTabStop(){value.content.splice(value.content.length-1,0,{type:'run',content:['\t']});},
      GetSection:()=>({GetColumnsWidths:()=>options.widths || [8640]}),
      GetParent:()=>doc, GetParentTable:()=>options.inTable || null,
      GetPosInParent(){return doc.items.indexOf(this);},
      ToJSON:()=>JSON.stringify(value),
      GetElementsCount:()=>value.content.length,
      GetElement(i) {
        const item=value.content[i];
        if(item.type==='paraMath') return {...item,GetClassType:()=> 'math', dk:{IEb(){calls.converted++;}}};
        return {GetClassType:()=> 'run',GetText:()=>item.content.join('')};
      },
      AddElement(m,index=value.content.length-1){value.content.splice(index,0,m);return true;},
      RemoveElement(index){if(options.removeMathFails)return false;value.content.splice(index,1);return true;},
      restore(data){value=copy(data);this.value=value;delete this.tabs;delete this.tabAlign;},
      ReplaceByElement(table) {
        if(options.replaceFails) return false;
        doc.items.splice(this.GetPosInParent(),1,table);return true;
      },
      GetRange(){return {MoveCursorToPos(){doc.current=p;return true;}};}
    };
    p.value=value;return p;
  }
  const logic = {
    Ru:{We(){},u_:()=>(options.bookmarks || []).length,Eo:i=>options.bookmarks[i]},
    mk:()=>({AT:math}), lf:()=>!!options.locked,
    pd(){calls.actions++;this.before=doc.items.slice();this.values=doc.items.map(p=>p.value?copy(p.value):null);},ld(){calls.finalized++;},
    Ec(){calls.recalc++;},Le(){},Xf(){}
  };
  const root={};
  const math={Lf:root,Ola:()=>!options.middle,Te:()=>!!options.selected,S1:()=>({aa:options.nested?{}:root})};
  const native={wa:{La:logic},Undo(){calls.undo++;doc.items=logic.before.slice();doc.items.forEach((p,i)=>{if(logic.values[i])p.restore(logic.values[i]);});},asc_GetLocalTrackRevisions:()=>!!options.track,Emb:0};
  logic.sb=native;
  doc = {
    Document:logic,items:[],GetClassType:()=> 'document',GetCurrentParagraph:()=>doc.current,IsTrackRevisions:()=>!!options.track,GetAllComments:()=>options.comments || [],
    GetRangeBySelect:()=>({GetTextPr:()=>({GetFontSize:()=>options.caretFontSize})}),
    AddElement(i,p){if(options.addFailsAt===i)return false;doc.items.splice(i,0,p);return true;},
    RemoveElement(i){doc.items.splice(i,1);return true;}
  };
  const original=paragraph(json);doc.items=[original];doc.current=original;
  Api={GetDocument:()=>doc,CreateMath:()=>({type:'paraMath',content:[mathRun('x')]}),FromJSON:s=>paragraph(JSON.parse(s)),CreateParagraph:()=>{const blank=source([]);blank.content=blank.content.filter(n=>n.type!=='paraMath');return paragraph(blank);},
    CreateRun:()=>({type:'run',content:[],AddTabStop(){this.content.push('\t');},AddLineBreak(){this.content.push('\n');}}),
    CreateTable(){assert.fail('numbered equations must never create a table');},
    attachEvent(name,handler){handlers[name]=handler;}};
  function legacyTable(data) {
    const t={GetClassType:()=> 'table',ToJSON:()=>JSON.stringify(data),GetParent:()=>doc,
      GetCell(r,c){return {GetContent:()=>({GetElement:()=>paragraph(data.content[r].content[c].content.content[0])})};},
      GetPosInParent(){return doc.items.indexOf(this);},
      ReplaceByElement(line){if(options.replaceFails)return false;doc.items.splice(this.GetPosInParent(),1,line);return true;}};
    doc.items=[t];original.GetParentTable=()=>t;return t;
  }
  const call=payload=>vm.runInNewContext('('+numberingCommand.toString()+')(payload)',{Api,payload});
  function enter(extra={}) {
    const e={iq:13,Tk:false,eH:false,vl:false,mnd:0,...extra};
    const handler=handlers.asc_onBeforeKeyDown;
    if(handler) handler.call(native,e);
    return e;
  }
  return {Api,doc,original,calls,call,enter,handlers,legacyTable};
}

test('accepts Word-style numeric, chapter and full-width labels without treating prose as a command',()=>{
  for(const [text,label] of [['x#(2)','(2)'],['x#（12）','（12）'],['x#(2-1)','(2-1)'],['x#(2.1a)','(2.1a)']]) assert.equal(parseInput(text).label,label);
  for(const text of ['x#(2）','x#（2)','x#(name)','x#(2) tail','x\\#(2)','\\text{x#(2)}','#(2)']) assert.equal(parseInput(text).label,null);
});
test('only strips the terminal root-level label and preserves existing formula structures and fonts',()=>{
  const fraction={type:'fraction',fPr:{type:'bar'},num:[mathRun('a')],den:[mathRun('b')]};
  const original=source([fraction,mathRun('#(2)')]);
  const result=parseParagraph(original);
  assert.equal(result.label,'(2)');
  assert.deepEqual(result.paragraph.content[1].content[0],fraction);
  assert.deepEqual(result.paragraph.content[1].content[1].rPr,original.content[1].content[1].rPr);
  assert.equal(original.content[1].content[1].content[0].value,35,'must not alter the source while preparing a replacement');
});
test('recognizes a label whose parentheses have already been built by the native editor',()=>{
  const j=source([mathRun('x#'),{type:'delimiter',dPr:{begChr:40,endChr:41},e:[[mathRun('2')]]}]);
  assert.equal(parseParagraph(j).label,'(2)');
});
test('prose, content controls, revisions and nested hashes are never rewritten',()=>{
  const prose=source();prose.content[0].content=[{type:'text',value:'Keep this text'}];
  const control=source();control.content.unshift({type:'inlineLvlSdt',content:[]});
  const revised=source();revised.changes=[{type:'insert'}];
  const revisedMath=source();revisedMath.content[1].content[0].reviewType='add';
  const nested=source([{type:'fraction',num:[mathRun('a#(2)')],den:[mathRun('b')]}]);
  for(const j of [prose,control,revised,revisedMath,nested]) assert.equal(parseParagraph(j),null);
});
test('unknown SDK versions do not register a native keyboard handler',()=>{
  const e=editor();
  assert.equal(e.call({action:'install',sdkVersion:'10.1.0'}).enabled,false);
  assert.equal(Object.keys(e.handlers).length,0);
});
test('native Enter creates an undoable table-free Word paragraph and an ordinary following paragraph',()=>{
  const e=editor();e.call({action:'install',sdkVersion:'10.0.0'});
  assert.equal(e.enter().iq,0);
  assert.equal(e.calls.actions,1);assert.equal(e.calls.finalized,1);assert.equal(e.calls.converted,1);
  assert.equal(e.doc.items.length,2);
  const line=e.doc.items[0];
  assert.equal(line,e.original,'keep paragraph identity and external annotation anchors');
  assert.equal(line.GetClassType(),'paragraph');
  assert.deepEqual(line.tabs,[4320,8640]);assert.deepEqual(line.tabAlign,['center','right']);
  assert.equal(line.jc,'left');assert.equal(line.value.content[0].content[0],'\t');
  assert.equal(line.value.content.at(-3).content[0],'\t');
  assert.equal(line.text,'(2)');
  assert.equal(e.doc.current,e.doc.items[1]);
});
test('protected paragraphs, nonempty selections, inner math arguments and a caret in the middle retain native Enter',()=>{
  for(const options of [{locked:true},{selected:true},{nested:true},{middle:true},{track:true},{inTable:true},{widths:[3600,4800]}]) {
    const e=editor(source(),options);e.call({action:'install',sdkVersion:'10.0.0'});
    assert.equal(e.enter().iq,13);assert.equal(e.calls.actions,0);assert.equal(e.doc.items[0],e.original);
  }
});
test('Shift/Ctrl/Alt Enter and non-Enter keys keep their original behavior',()=>{
  for(const extra of [{vl:true},{Tk:true},{eH:true},{iq:9}]) {
    const e=editor();e.call({action:'install',sdkVersion:'10.0.0'});
    assert.equal(e.enter(extra).iq,extra.iq || 13);assert.equal(e.calls.actions,0);
  }
});
test('failed native replacement rolls back its own insertion and preserves the original equation',()=>{
  const e=editor(source(),{removeMathFails:true});e.call({action:'install',sdkVersion:'10.0.0'});
  assert.equal(e.enter().iq,13);assert.equal(e.calls.undo,1);
  assert.equal(e.doc.items.length,1);assert.equal(e.doc.items[0],e.original);
  assert.deepEqual(e.original.value,source());
  assert.match(e.call({action:'status'}).lastError,/替换/);
});
test('equal-width journal columns use column width instead of whole-page width',()=>{
  const e=editor(source(),{widths:[3600]});e.call({action:'install',sdkVersion:'10.0.0'});e.enter();
  assert.deepEqual(e.doc.items[0].tabs,[1800,3600]);
});
test('full-width Chinese labels are ordinary text at the same right tab stop',()=>{
  const ascii=editor();ascii.call({action:'install',sdkVersion:'10.0.0'});ascii.enter();
  const chinese=editor(source([mathRun('x#（3）')]));chinese.call({action:'install',sdkVersion:'10.0.0'});chinese.enter();
  assert.deepEqual(chinese.doc.items[0].tabs,ascii.doc.items[0].tabs);
  assert.equal(chinese.doc.items[0].text,'（3）');
});
test('repeated initialization does not register duplicate handlers or reset successful numbering',()=>{
  const e=editor();e.call({action:'install',sdkVersion:'10.0.0'});e.enter();
  const handler=e.handlers.asc_onBeforeKeyDown;
  e.call({action:'install',sdkVersion:'10.0.0'});
  assert.equal(e.handlers.asc_onBeforeKeyDown,handler);
  assert.equal(e.call({action:'status'}).count,1);
});

test('panel insertion uses the same table-free layout and does not transfer its tab stops to body text',()=>{
  const e=editor();const result=e.call({action:'insert',value:'x#(2)'});
  assert.equal(result.numbered,true);assert.equal(e.doc.items.length,3);
  assert.deepEqual(e.doc.items[1].tabs,[4320,8640]);assert.equal(e.doc.items[1].text,'(2)');
  assert.equal(e.doc.current,e.doc.items[2]);assert.equal(e.doc.items[2].tabs,undefined);
});

test('an unavailable tab API or failed trailing paragraph does not leave half an equation',()=>{
  const e=editor(source(),{tabsFail:true});
  assert.throws(()=>e.call({action:'insert',value:'x#(2)'}),/对齐/);assert.equal(e.doc.items.length,1);
  const trailing=editor(source(),{addFailsAt:2});
  assert.throws(()=>trailing.call({action:'insert',value:'x#(2)'}),/正文/);assert.equal(trailing.doc.items.length,1);
});

function legacyJson(count=1) {
  const empty=()=>({type:'paragraph',pPr:{},changes:[],content:[{type:'run',content:[]},{type:'endRun',content:[]}]});
  return {type:'table',tblPr:{inline:true,tblLayout:'fixed',tblBorders:Object.fromEntries(['top','bottom','start','end','insideH','insideV'].map(n=>[n,{value:'none'}]))},
    content:Array.from({length:count},(_,i)=>({content:[empty(),source([mathRun('E=mc^2')]),{...empty(),content:[{type:'run',content:['('+(i+1)+')']},{type:'endRun',content:[]}]}].map((p,c)=>({tcPr:{tcW:{w:c===1?7680:480},tcBorders:{}},content:{content:[p]}}))}))};
}

test('converts a selected old formula table, including adjacent formula rows, while preserving math JSON',()=>{
  const e=editor();const j=legacyJson(2);e.legacyTable(j);
  const result=e.call({action:'convert-current'});
  assert.equal(result.count,2);assert.equal(e.doc.items.length,2);
  e.doc.items.forEach((line,i)=>{
    assert.equal(line.GetClassType(),'paragraph');assert.deepEqual(line.tabs,[4320,8640]);
    assert.equal(line.text,'('+(i+1)+')');
    const formula=line.value.content.find(n=>n.type==='paraMath');
    assert.deepEqual(formula.content[0],j.content[i].content[1].content.content[0].content[1].content[0]);
  });
});

test('conversion rejects data tables, annotations, tracked edits and non-formula content before changing the document',()=>{
  for(const mutate of [
    j=>{j.tblPr.tblBorders.top.value='single';},
    j=>{j.content[0].content[0].content.content[0].content[0].content=['Keep me'];},
    j=>{j.content[0].content[1].content.content[0].changes=[{type:'insert'}];},
    j=>{j.content[0].content[2].content.content[0].content[0].content=['Table 2'];},
    j=>{j.content[0].content[1].tcPr.vMerge='restart';}
  ]) {
    const e=editor();const j=legacyJson(2);mutate(j);const table=e.legacyTable(j);
    assert.throws(()=>e.call({action:'convert-current'}));assert.deepEqual(e.doc.items,[table]);
  }
});

test('a failed table replacement removes prepared sibling paragraphs and keeps all old formulas',()=>{
  const e=editor(source(),{replaceFails:true});const table=e.legacyTable(legacyJson(3));
  assert.throws(()=>e.call({action:'convert-current'}),/不可修改/);assert.deepEqual(e.doc.items,[table]);
});

test('conversion preserves annotated or referenced documents, including hidden Word cross-reference targets',()=>{
  for(const options of [{comments:[{}]},{bookmarks:['_Ref12345']},{bookmarks:['eq_energy']},{track:true}]) {
    const e=editor(source(),options);const table=e.legacyTable(legacyJson());
    assert.throws(()=>e.call({action:'convert-current'}),/批注|书签|修订/);assert.deepEqual(e.doc.items,[table]);
  }
  const navigation=editor(source(),{bookmarks:['_GoBack']});navigation.legacyTable(legacyJson());
  assert.equal(navigation.call({action:'convert-current'}).converted,true);
});

test('long-equation numbering can move to a right-aligned following line without changing math or adding duplicate breaks',()=>{
  const e=editor();e.call({action:'insert',value:'x#(2)'});e.doc.current=e.doc.items[1];
  const line=e.doc.current, formula=copy(line.value.content.find(n=>n.type==='paraMath'));
  assert.equal(e.call({action:'number-next-line'}).changed,true);
  assert.deepEqual(line.value.content.find(n=>n.type==='paraMath'),formula);
  assert.deepEqual(line.value.content.find(n=>n.content?.includes('\n')).content,['\n','\t']);
  assert.equal(e.call({action:'number-next-line'}).changed,false);
  assert.equal(line.value.content.filter(n=>n.content?.includes('\n')).length,1);
});

test('the long-equation control refuses an ordinary prose paragraph',()=>{
  const e=editor();assert.throws(()=>e.call({action:'number-next-line'}),/编号公式/);
});

test('panel numbering inherits the effective insertion size rather than a detached paragraph default',()=>{
  for(const size of [21,24,32]) {
    const e=editor(source(),{caretFontSize:size});e.call({action:'insert',value:'a+b#(1)'});
    assert.equal(e.doc.items[1].fontSize,size);
  }
});

test('native numbering retains math formatting and gives the ordinary label the effective caret size',()=>{
  const e=editor(source(),{caretFontSize:24});e.call({action:'install',sdkVersion:'10.0.0'});e.enter();
  assert.equal(e.original.numberFontSize,24);
  assert.equal(e.original.fontSize,undefined,'do not restyle all existing math runs');
});

test('missing effective caret formatting falls back to the source paragraph instead of a hard-coded size',()=>{
  const e=editor();e.call({action:'insert',value:'x#(1)'});
  assert.equal(e.doc.items[1].fontSize,22);
});
