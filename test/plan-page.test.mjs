import test from 'node:test';
import assert from 'node:assert/strict';
import {describePlan} from '../src/plan-page.mjs';
import {planFAQs} from '../src/plan-faqs.mjs';
import {appPage} from '../src/app-page.mjs';
import {setupGuideHtml} from '../src/setup-guide.mjs';
test('plan details distinguish monthly, annual, free test pricing and unknown billing intervals',()=>{
 const monthly=describePlan({active:true,billingPeriod:'EVERY_30_DAYS',items:[{active:true,description:'Basic',amount:'20',currency:'USD'}]});assert.equal(monthly.name,'Basic');assert.equal(monthly.period,'Monthly');assert.equal(monthly.price,'$20.00 USD');
 const annual=describePlan({active:true,billingPeriod:'ANNUAL',items:[{active:true,amount:'192',currency:'USD'}]});assert.equal(annual.period,'Annual');assert.equal(annual.price,'$192.00 USD');
 const free=describePlan({active:true,billingPeriod:'EVERY_30_DAYS',items:[{active:false,amount:'0',currency:'USD'}]});assert.equal(free.price,'$0.00 USD');
 assert.equal(describePlan({active:true}).period,'Unavailable');assert.equal(describePlan({active:true}).price,null);assert.equal(describePlan({active:false}).name,'No active plan');
});
test('Plan is separately navigable, contains the subscription and FAQ, and Home has only subsection progress',()=>{
 const html=appPage('client'),home=html.slice(html.indexOf('<div data-page-view="home">'),html.indexOf('<div data-page-view="inventory"'));
 assert.ok(!home.includes('id="billingPanel"'));assert.ok(html.includes('data-page-view="plan"'));assert.ok(html.includes('href="/plan"'));assert.ok(html.includes('id="billingPanel"'));assert.ok(html.includes('id="faqSearch"'));
 assert.ok(!setupGuideHtml.includes('id="setupProgress"'));assert.ok(!setupGuideHtml.includes('id="setupCount"'));assert.ok(setupGuideHtml.includes('inventorySetupCount'));assert.ok(setupGuideHtml.includes('productSetupCount'));
 const questions=planFAQs.flatMap(([,rows])=>rows.map(([q])=>q));assert.equal(new Set(questions).size,questions.length);assert.ok(questions.length>=50);
});
