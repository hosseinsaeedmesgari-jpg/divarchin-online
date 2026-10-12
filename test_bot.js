'use strict';
const assert=require('node:assert/strict');
const {initialState,legalMoves,legalWall,hasWallBlock}=require('./server');
const {chooseAction,shortest}=require('./bot');
for(const difficulty of ['easy','medium','hard']){
  for(let i=0;i<30;i++){
    const game=initialState(0);
    const before=JSON.stringify(game);
    const action=chooseAction(game,difficulty,{legalMoves,legalWall,hasWallBlock});
    assert.equal(JSON.stringify(game),before, 'Bot must not mutate game during decision');
    if(action.type==='move') assert(legalMoves(game,1).some(p=>p.r===action.r&&p.c===action.c));
    else assert(legalWall(game,action.o,action.r,action.c));
    assert(Number.isFinite(shortest(game,1,hasWallBlock)));
  }
}
console.log('PASS: easy / medium / hard bots always produce legal actions.');
process.exit(0);
