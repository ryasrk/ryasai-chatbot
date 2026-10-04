import {expect,test} from 'bun:test'
import {qualityGateFailures} from './quality-gates'
const measured = {samples:40,minimumSamples:40,metrics:{accuracy:{value:0.95,minimum:0.9}}}
test('measured quality above its threshold passes',()=>expect(qualityGateFailures(measured)).toEqual([]))
test('empty samples and absent metrics cannot pass',()=>{
 expect(qualityGateFailures({...measured,samples:0})).not.toEqual([])
 expect(qualityGateFailures({...measured,metrics:{}})).not.toEqual([])
})
test('NaN, infinity and invalid thresholds cannot bypass comparisons',()=>{
 for(const value of [NaN,Infinity,-1,1.01]) expect(qualityGateFailures({...measured,metrics:{accuracy:{value,minimum:0.9}}})).not.toEqual([])
 for(const minimum of [NaN,Infinity,-1,1.01]) expect(qualityGateFailures({...measured,metrics:{accuracy:{value:0.95,minimum}}})).not.toEqual([])
})
test('regression, skipped judgements and self-judging fail independently',()=>{
 expect(qualityGateFailures({...measured,metrics:{accuracy:{value:0.8,minimum:0.9}}})).not.toEqual([])
 expect(qualityGateFailures({...measured,skipped:1})).not.toEqual([])
 expect(qualityGateFailures({...measured,independentJudge:false})).not.toEqual([])
})
