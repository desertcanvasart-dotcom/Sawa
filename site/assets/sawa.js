/* SAWA — shared interactions (nav, mobile menu, scroll reveal, progress bars,
   accordion, tabs, copy buttons). Safe to load on every page. */
(function(){
  /* nav shadow on scroll */
  var nav=document.getElementById('nav');
  if(nav){
    var onScroll=function(){nav.classList.toggle('tight',window.scrollY>20);};
    window.addEventListener('scroll',onScroll,{passive:true});onScroll();
  }

  /* mobile overlay */
  var ov=document.getElementById('overlay');
  var open=document.getElementById('open');
  var close=document.getElementById('close');
  if(ov&&open){
    open.onclick=function(){ov.classList.add('open');document.body.style.overflow='hidden';};
    var closeMenu=function(){ov.classList.remove('open');document.body.style.overflow='';};
    if(close)close.onclick=closeMenu;
    ov.querySelectorAll('a').forEach(function(a){a.onclick=closeMenu;});
  }

  /* reveal + fill bars */
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(!e.isIntersecting)return;
        e.target.classList.add('in');
        e.target.querySelectorAll('[data-fill]').forEach(function(b){b.style.width=b.dataset.fill;});
        io.unobserve(e.target);
      });
    },{threshold:.16,rootMargin:'0px 0px -7% 0px'});
    document.querySelectorAll('.rv').forEach(function(el){io.observe(el);});
  } else {
    document.querySelectorAll('.rv').forEach(function(el){el.classList.add('in');});
    document.querySelectorAll('[data-fill]').forEach(function(b){b.style.width=b.dataset.fill;});
  }

  /* fire above-the-fold bars early */
  setTimeout(function(){
    document.querySelectorAll('.phero [data-fill],.early [data-fill]').forEach(function(b){b.style.width=b.dataset.fill;});
  },500);

  /* tabs (visual) */
  document.querySelectorAll('[data-tabs]').forEach(function(group){
    group.querySelectorAll('.tab').forEach(function(t){
      t.onclick=function(){
        group.querySelectorAll('.tab').forEach(function(x){x.classList.remove('on');});
        t.classList.add('on');
      };
    });
  });

  /* accordion */
  document.querySelectorAll('.acc .q').forEach(function(q){
    q.onclick=function(){
      var item=q.closest('.item');
      var a=item.querySelector('.a');
      var isOpen=item.classList.contains('open');
      if(isOpen){item.classList.remove('open');a.style.maxHeight=null;}
      else{item.classList.add('open');a.style.maxHeight=a.scrollHeight+'px';}
    };
  });

  /* copy buttons */
  document.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.onclick=function(){
      var target=document.querySelector(btn.getAttribute('data-copy'));
      if(!target)return;
      var text=target.innerText||target.textContent;
      navigator.clipboard&&navigator.clipboard.writeText(text);
      var old=btn.textContent;btn.textContent='Copied';
      setTimeout(function(){btn.textContent=old;},1600);
    };
  });
})();
