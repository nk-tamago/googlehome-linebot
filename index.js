'use strict';

const line = require('@line/bot-sdk');
const express = require('express');
const ngrok = require('ngrok');
const nedb = require('nedb');
const googlehome = require('google-home-notifier');
const bodyParser = require('body-parser');
const firebase = require("firebase-admin");
const serverPort = 8080;

const appconfig = require('./appconfig.json');

// LINE BOT関係
const linePushSource =  { source : {type : "none"} };
const lineconfig = {
  channelAccessToken: appconfig.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: appconfig.LINE_CHANNEL_SECRET
};
// create LINE SDK client
const lineclient = new line.Client(lineconfig);


// firebase関係
const firebaseServiceAccount = require(appconfig.FIREBASE_SERVICEACCOUNT_PRIVATEKEY);
firebase.initializeApp({
  credential: firebase.credential.cert(firebaseServiceAccount),
  databaseURL: appconfig.FIREBASE_DATABASE_URL
})
const lineReceiveRef = firebase.database().ref("/linebot/receive");
const lineSendRef = firebase.database().ref("/linebot/send");
const googlehomeUnreadRef = firebase.database().ref("/googlehome/unread");
const googlehomeBeforeRef = firebase.database().ref("/googlehome/before");


// google home 関係
const GOOGLEHOME_EVENT_TYPE ={
  UNREAD : "unread",
  BEFORE : "before",
  SEND : "send"
}
const deviceName = 'Google Home';
googlehome.device(deviceName,'ja');
googlehome.accent('ja'); // uncomment for british voice
googlehome.ip(appconfig.GOOGLEHOME_DEVICE_ADDRESS);

const check_beforemin = 5; // 何分まえまで直前のメッセージを再生するか
const urlencodedParser = bodyParser.urlencoded({ extended: false });


// データベース関係
const db = new nedb({
//    filename: 'database.db',
    inMemoryOnly :true,
    autoload: true
  });

  // インデックス
['readtimestamp','timestamp'].map( (attr) => {
  db.ensureIndex({ fieldName: attr }, function (err) {
    if( err != null ){
      console.log("err ensureIndex "+attr);
    }
  });
});


// create Express app
// about Express itself: https://expressjs.com/
const app = express();


// googlehome用webhook
app.post('/googlehome-webhook', urlencodedParser, (req, res) => {
  if (!req.body) return res.sendStatus(400)
//  console.log(req.body);

  let events = JSON.parse(req.body.events);
  Promise
    .all(events.map(googlehomeHandleEvent))
    .then((result) => {
      res.json(result)
    }).catch((err) =>{
      res.json(err)
    });
});

// LINE BOT用webhook
app.post('/line-webhook', line.middleware(lineconfig), (req, res) => {
  Promise
    .all(req.body.events.map((value)=>{lineHandleEvent(value, true)}))
    .then((result) => {
      res.json(result)
    }).catch((err) =>{
      res.json(err)
    });
});

//----------------------------------
// 以下、firebaseによるwebhookの代わり
// ngrokを使ったwebhookのURLが起動ごとに変わるので、firebaseで代用

// firebase LINE BOTの受信
lineReceiveRef.on("value", function(snapshot) {
  lineHandleEvent(snapshot.val(),false);
//  console.log(snapshot.val());
}, function (errorObject) {
  console.log("The read failed: " + errorObject.code);
});

// firebase LINE BOTへの送信
lineSendRef.on("value", function(snapshot) {
  new Promise( function(resolve, reject) {
    const event = {text:snapshot.val()};
    pushLinebotMessage( event, resolve, reject );
  });
//  console.log(snapshot.val());
}, function (errorObject) {
  console.log("The read failed: " + errorObject.code);
});

// firebase googlehome用の未読メッセージ確認
googlehomeUnreadRef.on("value", function(snapshot) {
  new Promise( function(resolve, reject) {
    callGooglehomeMessage(0, null, resolve, reject);
  });
//  console.log(snapshot.val());
}, function (errorObject) {
  console.log("The read failed: " + errorObject.code);
});

// firebase googlehome用のさっきのメッセージ確認
googlehomeBeforeRef.on("value", function(snapshot) {
  new Promise( function(resolve, reject) {
    callGooglehomeMessage(check_beforemin, null, resolve, reject);
  });
//  console.log(snapshot.val());
}, function (errorObject) {
  console.log("The read failed: " + errorObject.code);
});

// -------------------------------------------------

// google home用のイベントハンドラ
function googlehomeHandleEvent(event) {
  let typeExist = false;
  for (key in GOOGLEHOME_EVENT_TYPE) {
    if( event.type == GOOGLEHOME_EVENT_TYPE[key]){
      typeExist = true;
      break;
    }
  }
  if( !typeExist ){
    return Promise.resolve(null);
  }

  return new Promise( function(resolve, reject) {
    googlehomeHandler[event.type]( event, resolve, reject );
  });

}

// LINE BOT用のイベントハンドラ
function lineHandleEvent(event, isReply) {
  if (event.type !== 'message' || event.message.type !== 'text' ) {
    // ignore non-text-message event
    return Promise.resolve(null);
  }
  
  return new Promise( function(resolve, reject) {
  // create a echoing text message
    setLinePushSource(event.source);
    getLineDisplayName(event.source).then( function(displayName){
//      console.log(event.message.text);

      Promise.resolve()
      .then( ()=>{
        let doc = {user: displayName, message: event.message.text, timestamp: event.timestamp, readtimestamp: 0}
        db.insert(doc, function(err, newDoc) {
//          console.dir(newDoc);
        });
      })
      .then( () => {
        let linenotify = displayName + "からLINE。";
        return googlehomeNotify(linenotify);
      })

      // firebase(dialogflow)の場合、CloudFunctionでreplyTokenを使って返信しているため呼ぶとエラーになる
      .then(() => {
        if(isReply){
          // use reply API
          let echo = { type: 'text', text: event.message.text + " を送ったよ。" };
          return client.replyMessage(event.replyToken, echo);
        }
      })
    })
  });

}


const googlehomeHandler = {
  // LINE最新メッセージ
  [GOOGLEHOME_EVENT_TYPE.UNREAD]: (event, resolve, reject) => {
    callGooglehomeMessage(0, event, resolve, reject);
  },
  // LINE先ほどのメッセージ
  [GOOGLEHOME_EVENT_TYPE.BEFORE]: (event, resolve, reject) => {
    callGooglehomeMessage(check_beforemin, event, resolve, reject);
  },
  [GOOGLEHOME_EVENT_TYPE.SEND]: (event, resolve, reject) => {
    pushLinebotMessage(event, resolve, reject);
  }
};

// 最後にやり取りした人、グループ、ルームにプッシュ送信する仕様とする
function pushLinebotMessage(event, resolve, reject){
  const linePushSourceType = {
    user : "userId",
    group : "groupId",
    room : "roomId",
  };
  
  const message = {
    type: 'text',
    text: event.text
  };

  Promise.resolve()
  .then( ()=>{
    if( linePushSource.source.type == "none" ){
      return "送り先がわかりません";
    }
    
    lineclient.pushMessage(linePushSource.source[linePushSourceType[linePushSource.source.type]], message);
//    return message.text + " を送信しました"
    return;

  }).then( (text) => {
    if( text != undefined ){
      return resolve( googlehomeNotify(text) );
    }
  }).catch( (err) => {
    return resolve( googlehomeNotify(err) );
  })
}

// google homeにLINE問い合わせ
function callGooglehomeMessage(beforemin, event, resolve, reject){
  const removeLimitMinutes = 60*24; // 1日たったら過去メッセージをDBから削除
  let checkdate  = new Date();
  let deletedate = new Date();
  // 既読になってから、何分間メッセージを再生できるか
  //beforemin分で設定
  checkdate.setMinutes(checkdate.getMinutes() - beforemin);
  deletedate.setMinutes(deletedate.getMinutes() - removeLimitMinutes);
  
  // 初回取得でかつ、現在時刻よりも遅いデータのみ取得タイムスタンプを設定
  // 実行中にLINE更新があった場合に更新されないように制御
  db.find({$or: [{ readtimestamp: 0 }, { readtimestamp: { $gt: checkdate.getTime() } }]}).sort({ timestamp: 1 }).exec( (err, docs) => {

    Promise.resolve()
    .then( ()=>{
      return new Promise( function(resolve, reject) {
        let nowdate = new Date();
        db.update({ $and: [{readtimestamp: 0}, {timestamp: { $lt: nowdate.getTime() } }]}, { $set: { readtimestamp: nowdate.getTime() } }, { multi: true }, (err, numReplaced) => {
//          console.log(numReplaced);
          db.remove({readtimestamp: { $lt: deletedate.getTime() } }, {multi: true}, (err, numRemoved) => {
//            console.log(numRemoved);
            // DB圧縮
            db.persistence.compactDatafile();
            resolve();
          });

        });
      });
    })
    .then( ()=>{
      return new Promise( function(resolve, reject) {
        return resolve(docs.map( (doc, index) => {
          let message = doc.message;
          let datetime = getDataTimeString(doc.timestamp);
          let user = doc.user;
          return datetime + "、" + user + "より、" + message;
        }).join("。"));
      });
    })
    .then( (responseMessage) => {
      if( docs.length == 0){
        responseMessage = "LINEは無いよ"
      }
      return googlehomeNotify(responseMessage);
    }).then( ( responseNotify ) => {
      return resolve( responseNotify );
    })
    .catch((err) =>{
      console.log(err);
      reject(err);
      return;
    });
  });
}

function googlehomeNotify(message){
  return new Promise( function(resolve, reject) {
    try {
      googlehome.notify(message, (notifyRes) => {
//        console.log(notifyRes);
        return resolve(notifyRes);
      });
    } catch(err) {
      console.log(err);
      reject(err);
      throw new Error("googlehomeNotify error");
    }
  });
}



function getDataTimeString( timestamp ){
  let d = new Date(timestamp);
  let year  = d.getFullYear().toString();
  let month = (d.getMonth() + 1).toString();
  let day  = d.getDate().toString();
  let hour = (( d.getHours()   < 10 ) ? '0' + d.getHours()   : d.getHours()).toString();
  let min  = (( d.getMinutes() < 10 ) ? '0' + d.getMinutes() : d.getMinutes()).toString();
  let sec   = (( d.getSeconds() < 10 ) ? '0' + d.getSeconds() : d.getSeconds()).toString();
  return month.toString() + "月" + day.toString() + "日" + hour.toString() + "時" + min.toString() + "分";
}



function setLinePushSource(source) {
  linePushSource.source = source;
}

function getLineDisplayName(source) {
  if( source.type == "group" ){
    return lineclient.getGroupMemberProfile(source.groupId, source.userId)
    .then((profile) => {
      return profile.displayName;
    })
    .catch((err) => {
      return err;
    });
  }
  else {
    return lineclient.getProfile(source.userId)
    .then((profile) => {
      return profile.displayName;
    })
    .catch((err) => {
      return err;
    });
  }
}

// listen on port
const port = process.env.PORT || 3000;
app.listen(port, () => {
/*
  ngrok.connect({
    addr: port,
    region: 'ap'
  } , function (err, url) {
    console.log(url);
    console.log(port);
  });
*/
  console.log(`listening on ${port}`);
});

