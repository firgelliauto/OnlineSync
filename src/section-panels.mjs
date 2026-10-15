export const sectionPanelsCss=`
details>summary{position:relative;list-style:none;cursor:pointer;padding-right:32px}details>summary::-webkit-details-marker{display:none}
details>summary::after,.section-details>summary::after,.setup-heading::after,.setup-category>summary::after,.setup-step>summary::after{content:'';position:absolute;right:4px;top:50%;width:18px;height:18px;flex-shrink:0;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none'%3E%3Cpath d='m5 7.5 5 5 5-5' stroke='%23476657' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/18px 18px no-repeat;transform:translateY(-50%) rotate(0deg);transform-origin:center;transition:transform 180ms ease;pointer-events:none}
details[open]>summary::after,.section-details[open]>summary::after,#setupGuide[open]>.setup-heading::after,.setup-category[open]>summary::after,.setup-step[open]>summary::after{content:'';transform:translateY(-50%) rotate(180deg)}
.section-details>summary::after{top:12px}
@media(prefers-reduced-motion:reduce){details>summary::after{transition:none}}

.section-details>summary{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:12px;list-style:none;cursor:pointer;padding-right:34px;margin:0}
.section-details>summary::-webkit-details-marker{display:none}

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
  if(!panel||panel.id==='inventoryModePanel'||panel.querySelector(':scope > .section-details'))continue;
  const heading=panel.querySelector('h2');if(!heading)continue;
  const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');details.className='section-details';body.className='section-body';details.open=true;
  const key='onlinesync:section:'+new URLSearchParams(location.search).get('shop')+':'+panel.id;
  try{const saved=localStorage.getItem(key);if(saved!==null&&panel.id!=='productPanel')details.open=saved==='open'}catch{}
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
