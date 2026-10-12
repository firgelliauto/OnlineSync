export const sectionPanelsCss=`
.section-details>summary{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:12px;list-style:none;cursor:pointer;padding-right:34px;margin:0}
.section-details>summary::-webkit-details-marker{display:none}
.section-details>summary::after{content:'⌄';position:absolute;right:4px;top:0;color:#476657;font-size:23px;line-height:1;transform:rotate(-90deg)}
.section-details[open]>summary::after{transform:none}
.section-details>summary h2{margin:0;font-size:16px}
.section-details>summary .inventory-switch{margin:0}
.section-details>summary:focus-visible{outline:2px solid #136f53;outline-offset:6px;border-radius:4px}
.section-body{padding-top:16px}
.section-content.is-off,.section-content:disabled{opacity:1;filter:none;background:#f4f6f5;border-radius:8px}
.section-content.is-off p,.section-content:disabled p{color:#52615d}
.section-content.is-off :is(input,select,textarea,button){opacity:.4!important;filter:grayscale(1)}
.section-content.is-off :is(.sku-rule-scroll,.mapping-scroll,.sample,.collection-list){opacity:.45;filter:grayscale(1)}
`;

export function sectionPanelsScript(){return `
function initializeSectionPanels(){
 const panels=new Set([...document.querySelectorAll('[data-page-view="inventory"] .panel,[data-page-view="products"] .panel'),...['activityPanel','activityExportPanel','safetyNetPanel','backupPanel'].map(id=>$(id))]);
 for(const panel of panels){
  if(!panel||panel.querySelector(':scope > .section-details'))continue;
  const heading=panel.querySelector('h2');if(!heading)continue;
  const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');details.className='section-details';body.className='section-body';details.open=true;
  const key='onlinesync:section:'+new URLSearchParams(location.search).get('shop')+':'+panel.id;
  try{const saved=localStorage.getItem(key);if(saved!==null)details.open=saved==='open'}catch{}
  summary.append(heading);
  if(panel.id==='inventorySelectionPanel'){for(const id of ['includedSwitch','excludedSwitch'])summary.append($(id))}
  else {const control=panel.querySelector('.inventory-switch');if(control)summary.append(control)}
  while(panel.firstChild)body.append(panel.firstChild);
  // On/Off controls act independently of the disclosure header.
  summary.addEventListener('click',event=>{if(event.target.closest('button'))event.preventDefault()});
  details.addEventListener('toggle',()=>{try{localStorage.setItem(key,details.open?'open':'closed')}catch{}});
  details.append(summary,body);panel.append(details);
 }
}
initializeSectionPanels();
`}
