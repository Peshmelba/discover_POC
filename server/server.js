/******* Require et dépendences *******/

var express = require('express');
var app = express();
var http = require('http').Server(app);
var path = require('path');
var io = require('socket.io')(http);
var nunjucks = require('nunjucks');
var storage = require('node-persist');
var getPixels = require("get-pixels");
var formReader = require('multer')();


/**************************************/
/********* Globales et config *********/

var client_path = path.resolve(__dirname, '../client'); //adresse du dossier client

var userStorage = storage.create();

var commands;

var lobbies = {};

// Configuration Nunjucks
nunjucks.configure(['views',client_path],{
	autoescape : true,
	express : app,
  noCache  : true   //pour le développement. Force la recompilation du template à chaque appel
});

// Configuration du storage
userStorage.initSync({
  dir : __dirname + '/data/user',
  interval : 5000 //persiste toutes les 5s
});


/**************************************/
/************** Routing ***************/

app.use(express.static(client_path + '/public'));

//get
app.get('/', ctrlIndex);
app.get('/:lbid', ctrlConnectLobby);
app.get('/delete/:suid', ctrlDelete);

//post
app.post('/', formReader.single('lobby_img'), ctrlNewLobby);


/**************************************/
/************* Controller *************/

//Renvoie la page d'accueil
function ctrlIndex(req, res) {
  res.render('index.html',{
    lobbies: lobbies,
    page: {url: req.protocol + '://' + req.get('host') + req.originalUrl},
    messages: req.messages
  });
}

//Renvoie la page d'un salon
function ctrlConnectLobby(req, res) {

  var lobby = req.params.lbid;
  if (lobby in lobbies) { 
    res.sendFile(client_path + '/discover.html');
  } else {
    res.redirect("/");
  }
}

function ctrlDelete(req, res) {

  var suid = req.params.suid;
  if (typeof lobbies[suid] != 'undefined')
  {
    deleteServer(suid);
    console.log("Server " + suid + " succesfully deleted !");
  }
  else
  {
    console.log("Server " + suid + " doesn't exist.");
  }
}

//Créer un nouveau salon
function ctrlNewLobby(req, res) {
//@todo : rework de la fonction. Lobby().error si une erreur est survenue.
  if (req.file) {
    getPixels(req.file.buffer, req.file.mimetype, function(err, pixels) {
      if (err) {
        console.log("Error when trying to read image data : " + err);

        res.redirect("/");
      } else {
      //@todo : tester si l'image correspond à certains critères
        var lbid;

        do lbid = genLbid(); while (!!lobbies[lbid]);

        lobbies[lbid] = newServer(lbid, pixels);

        console.log("New lobby created - ID("+lbid+")");

        res.redirect("/"+lbid);
      }
    });
  } else {
    res.redirect("/");
  }
}


/**************************************/
/******** Socket.io listeners *********/
io.use(function(socket, next){
  var lbid = socket.handshake.query.lbID || null;
  if (!!lobbies[lbid]) {
    console.log('SocketIO : connection accepted on '+lbid);
    next();          
  } else {
    console.log('SocketIO : connection denied on '+lbid+', lobby does not exist');
    next(new Error('Failed to connect.'));                  
  }
  return;
});
io.on('connection', function(socket) {

  var userID = socket.handshake.query.userID;
  //socket.user = userStorage.getItem(userID) || newClient(genUUID();
  
  if (!userStorage.getItem('USER_' + userID)) {
    userID = genUUID();
    var user = newClient(userID);
    userStorage.setItem(user.key, user);

    console.log("New user created - ID(" + user.id + ")\n");
  }

  socket.user = userStorage.getItem('USER_' + userID);
  socket.lbid = socket.handshake.query.lbID;
  console.log(socket.user.key + ' connected on ' + socket.lbid);
  
  socket.emit('update:connect', {
    user: {
      id: socket.user.id,
      hov: socket.user.stats.pxlHovered,
      disc: socket.user.stats.pxlScrub,
      mdisc: socket.user.stats.pxlScrubM
    },
    img: {
      w: lobbies[socket.lbid].img.width,
      h: lobbies[socket.lbid].img.height,
      map: lobbies[socket.lbid].img.map
    }
   
  }); 

  for(var cmd in commands)
  {
    socket.on(cmd, commands[cmd]);
  }

});

// Listeners
commands = {
  'cmd:move'  : cmdMove,
  'cmd:scrub' : cmdScrub,
  'cmd:use'   : cmdUse,
  'cmd:buy'   : cmdBuy
};

function cmdMove(pos) {

  if ((pos.x >= 0) && (pos.x < lobbies[this.lbid].img.width)
    && (pos.y >= 0) && (pos.y < lobbies[this.lbid].img.height)) {
    var data = {};

    data.pos = pos;

    data.hover = ++this.user.stats.pxlHovered;

    if (!lobbies[this.lbid].img.map[pos.x][pos.y]) {

      data.scrub = ++this.user.stats.pxlScrub;
      data.scrubM = ++this.user.stats.pxlScrubM;

      var color = {};
      color.r = lobbies[this.lbid].img.data.get(pos.x,pos.y,0);
      color.g = lobbies[this.lbid].img.data.get(pos.x,pos.y,1);
      color.b = lobbies[this.lbid].img.data.get(pos.x,pos.y,2);

      lobbies[this.lbid].img.map[pos.x][pos.y] = color;

      data.color = color;
    }
    userStorage.setItem(this.user.key, this.user);


    this.emit('update:hovered', data);
  }
}

function cmdScrub(pos) {

  this.user.stats.pxlScrubM += 1;

  this.user.stats.pxlScrub += 1;
  userStorage.setItem(this.user.key, this.user);

  var data = {
    scrub   : this.user.stats.pxlScrub, 
    scrubM  : this.user.stats.pxlScrubM
  };

  this.emit('update:scrub', data);
}

function cmdUse(pos, id) {
  //not handled yet

  this.emit('update:item', this.user.stats.items);
}

function cmdBuy(id) {

  userStorage.setItem(this.user.key, this.user);

  this.emit('update:point', this.user.stats.points);
}


/**************************************/
/************** SERVER ****************/

http.listen(8080, function() {
  console.log('listening on *:8080');
});


/**************************************/
/************* Function ***************/

function genUUID() {
    var S4 = function() {
       return (((1+Math.random())*0x10000)|0).toString(16).substring(1);
    };
    return (S4()+S4()+"-"+S4()+"-"+S4()+"-"+S4()+"-"+S4()+S4()+S4());
}

function genLbid() {
  var lbid = "",
    possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    i = 0;

  for (i=0; i<4; ++i) {
    lbid += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return lbid;
}

function newServer(suid, imgData)
{
  var info = imgData.shape.slice();
  var w = info[0],
    h = info[1];

  var map = new Array(w);
  for (var i=0;i<map.length;i++) map[i] = new Array(h).fill(false);

  return {
    id : suid,
    users : [],
    img : {
      data : imgData,
      width : w,
      height : h,
      map : map, 
      pxlCount : w*h,
      pxlFound : 0
    },
    startTime : new Date(),
  };
}

function newClient(uuid)
{
  return {
    id  : uuid,
    key : 'USER_' + uuid,
    last : {
      time : 0,
      pos : {
        x : 0,
        y : 0
      }
    },
    items : {},
    stats : {
      pxlScrubM   : 0, //scrub manually
      pxlScrub    : 0,
      pxlHovered  : 0,
      playtime    : 0,
      imgFinished : 0,
      points      : 0
    },
    session : {
      playtime    : 0,
      pxlScrubM   : 0, //scrub manually
      pxlScrub    : 0,
      pxlHovered  : 0
    }
  };
}

function deleteServer(suid)
{
  delete lobbies[suid];
}

/**************************************/