const axios = require("axios");
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
    try {
      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      const password = hashedPassword;

      const { username } = req.body;
      const userExists = await Dev.findOne({ user: username });

      if (userExists) {
        return res.json(userExists);
      }

      const response = await axios.get(
        `https://api.github.com/users/${username}`
      );

      const { name, bio, avatar_url: avatar } = response.data;

      const dev = await Dev.create({
        user: username,
        password: password,
        name,
        bio,
        avatar
      });

      return res.json(dev);
    } catch {
      res.status(500).send();
    }
  }
};
