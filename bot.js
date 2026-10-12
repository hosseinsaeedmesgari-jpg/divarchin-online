'use strict';
// Server-side computer opponent. It never has an account and never earns rating.
function shortest(game, player, hasWallBlock) {
  const start = game.pawns[player], goal = player === 0 ? 0 : 8;
  const q = [[start.r,start.c,0]], seen = new Set([start.r*9+start.c]);
  for (let i=0;i<q.length;i++) {
    const [r,c,d] = q[i]; if(r===goal)return d;
    for (const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nr=r+dr,nc=c+dc,k=nr*9+nc;
      if(nr<0||nr>=9||nc<0||nc>=9||seen.has(k)||hasWallBlock(game.walls,{r,c},{r:nr,c:nc}))continue;
      seen.add(k);q.push([nr,nc,d+1]);
    }
  }
  return Infinity;
}
function chooseAction(game,difficulty,helpers) {
  const {legalMoves,legalWall,hasWallBlock}=helpers, botId=1, moves=legalMoves(game,botId);
  if(!moves.length)throw new Error('Bot has no legal moves');
  const random = arr=>arr[Math.floor(Math.random()*arr.length)];
  const goal=8;
  const evaluateMove = p=>{
    const saved=game.pawns[botId];game.pawns[botId]=p;
    const distance=shortest(game,botId,hasWallBlock);
    game.pawns[botId]=saved;
    return distance;
  };
  const bestDist=Math.min(...moves.map(evaluateMove));
  const bestMoves=moves.filter(p=>evaluateMove(p)===bestDist);
  const candidateMove=random(bestMoves);
  if(difficulty==='easy') {
    if(game.remaining[botId]>0 && Math.random()<.12) {
      for(let n=0;n<20;n++) {const o=Math.random()<.5?'h':'v',r=Math.floor(Math.random()*8),c=Math.floor(Math.random()*8);
        if(legalWall(game,o,r,c))return {type:'wall',o,r,c};}
    }
    const p=random(moves);return {type:'move',r:p.r,c:p.c};
  }
  const myDist=shortest(game,botId,hasWallBlock), theirDist=shortest(game,0,hasWallBlock);
  const considerWall=game.remaining[botId]>0 && (difficulty==='hard'||Math.random()<.3);
  if(considerWall && (difficulty==='hard'||theirDist < myDist)) {
    let best=null, gain= difficulty==='hard' ? 1.7 : 2.2;
    const candidates=[];
    for(let r=0;r<8;r++)for(let c=0;c<8;c++)for(const o of ['h','v']) {
      // A wall far away from either pawn rarely matters; still allow hard mode to evaluate the board.
      if(difficulty!=='hard' && Math.abs(r-game.pawns[0].r)>3)continue;
      candidates.push({o,r,c});
    }
    for(const w of candidates) {
      if(!legalWall(game,w.o,w.r,w.c))continue;
      game.walls.push({...w,owner:botId});
      const afterThem=shortest(game,0,hasWallBlock), afterUs=shortest(game,botId,hasWallBlock);
      game.walls.pop();
      const score=(afterThem-theirDist)-(afterUs-myDist)*1.25;
      if(score>gain) {gain=score;best=w;}
    }
    if(best && (difficulty==='hard' ? myDist >= theirDist-2 || gain >= 3 : true)) return {type:'wall',...best};
  }
  return {type:'move',r:candidateMove.r,c:candidateMove.c};
}
module.exports={chooseAction,shortest};
