const Dev = require("../models/Dev");
const bcrypt = require("bcrypt");

module.exports = {
  async index(req, res) {
    const { user } = req.headers;

    const loggedDev = await Dev.findById(user);

    const users = await Dev.find({
      $and: [
        { id: { $ne: user } },
        { id: { $nin: loggedDev.likes } },
        { id: { $nin: loggedDev.dislikes } }
      ]
    });
    return res.json(users);
  },

  async store(req, res) {
    const user = users.find(user => (users.username = req.body.username));
    if (user == null) {
      return res.status(400).send("Cannot find user");
    }
    try {
      if (await bcrypt.compare(req.body.password, user.password)) {
        res.send("Sucess");
      } else {
        res.send("Not Allowed");
      }
    } catch {
      res.status(500).send();
    }
  }
};
