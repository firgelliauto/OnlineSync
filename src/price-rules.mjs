function invalid(message){const error=new Error(message);error.status=400;throw error;}
function decimal(value,places){
  const text=String(value??'0');
  if(text.length>32)invalid('Price adjustment is too long');
  if(!new RegExp('^-?\\d+(?:\\.\\d{1,'+places+'})?$').test(text))invalid('Enter a valid price adjustment');
  const negative=text.startsWith('-'),parts=text.replace(/^-/,'').split('.');
  return BigInt(parts[0])*10n**BigInt(places)*(negative?-1n:1n)+BigInt((parts[1]||'').padEnd(places,'0'))*(negative?-1n:1n);
}
export function normalizeRule(rule={}){
  if(!rule||typeof rule!=='object'||Array.isArray(rule))invalid('Choose a valid price rule');
  const percent=String(rule.percent??'0'),amount=String(rule.amount??'0');
  const p=decimal(percent,2),a=decimal(amount,3);
  if(p < -10000n||p>1000000n||a < -1000000000n||a>1000000000n)invalid('Price adjustment is outside the allowed range');
  const rounding=rule.rounding??'none';
  if(!['none','whole','up99'].includes(rounding))invalid('Choose a supported rounding rule');
  if(rule.applyToCompareAt!==undefined&&typeof rule.applyToCompareAt!=='boolean')invalid('Choose whether the rule applies to compare-at prices');
  return {percent,amount,rounding,applyToCompareAt:rule.applyToCompareAt??false};
}
export function adjustedPrice(value,rule={},currency='USD'){
  if(value===null||value===undefined)return value;
  rule=normalizeRule(rule);
  const digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  // Shopify money can contain trailing zeros beyond a currency's minor unit.
  const normalized=String(value).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
  const base=decimal(normalized,Math.max(1,digits));
  const scale=10n**BigInt(Math.max(1,digits)),minorScale=10n**BigInt(digits);
  const p=decimal(rule.percent,2),amount=decimal(rule.amount,3);
  const raw=base*(10000n+p)*1000n+amount*scale*10000n;
  if(raw<0n)invalid('This price rule produces a negative price');
  const denominator=10000000n*scale/minorScale;
  let minor=(raw+denominator/2n)/denominator;
  if(rule.rounding==='whole')minor=((minor+minorScale/2n)/minorScale)*minorScale;
  if(rule.rounding==='up99'){
    if(digits!==2)invalid('Prices ending in .99 require a currency with two decimal places');
    minor=((minor+100n)/100n)*100n-1n;
  }
  if(minor>100000000000n)invalid('This price rule produces an excessive price');
  return digits?String(minor/minorScale)+'.'+String(minor%minorScale).padStart(digits,'0'):String(minor);
}
